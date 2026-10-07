// Réconciliation d'un MySQLCluster : ressources, rôles, réplication, backups planifiés.
const kube = require('./kube');
const mysql = require('./mysql');
const r = require('./resources');

const decode = (secret, key) => (secret.data && secret.data[key] ? Buffer.from(secret.data[key], 'base64').toString() : null);
const isReady = (pod) => !!(pod.status && (pod.status.conditions || []).some((c) => c.type === 'Ready' && c.status === 'True'));
const ordinalOf = (pod) => Number(pod.metadata.name.match(/-(\d+)$/)[1]);

async function setStatus(cr, status) {
  if (JSON.stringify(cr.status || {}) === JSON.stringify({ ...(cr.status || {}), ...status })) return;
  await kube.merge('MySQLCluster', cr.metadata.namespace, cr.metadata.name, { status }, 'status');
}

// Hôte utilisé pour les dumps : un réplica sain si possible, sinon le primaire.
function dumpHostFor(name, instances) {
  const n = r.names(name);
  const healthyReplica = (instances || []).some((i) => i.role === 'replica' && i.ready && i.replicating);
  return healthyReplica ? n.readService : n.primaryService;
}

async function reconcileCluster(cr) {
  const ns = cr.metadata.namespace;
  const name = cr.metadata.name;
  const spec = r.withDefaults(cr.spec || {});
  const n = r.names(name);
  const owners = r.ownerRefs(cr, 'MySQLCluster');

  const secret = await kube.get('Secret', ns, spec.secretName);
  if (!secret) {
    return setStatus(cr, { phase: 'Pending', message: `secret ${spec.secretName} introuvable` });
  }
  const rootPassword = decode(secret, 'MYSQL_ROOT_PASSWORD');
  const replPassword = decode(secret, 'MYSQL_REPLICATION_PASSWORD');
  if (!rootPassword || !replPassword) {
    return setStatus(cr, { phase: 'Pending', message: 'secret incomplet: MYSQL_ROOT_PASSWORD et MYSQL_REPLICATION_PASSWORD requis' });
  }

  await kube.apply(r.service(n.headless, ns, name, owners, { headless: true }));
  await kube.apply(r.service(n.primaryService, ns, name, owners, { role: 'primary' }));
  await kube.apply(r.service(n.readService, ns, name, owners, { role: 'replica' }));
  await kube.apply(r.statefulSet(cr, spec, ns));
  await kube.apply(r.backupsPvc(name, ns, spec));

  // Rôles : l'ordinal 0 est le primaire, les autres sont des réplicas.
  const pods = (await kube.list('Pod', ns, `app.kubernetes.io/instance=${name},app.kubernetes.io/name=mysql`))
    .filter((p) => /-\d+$/.test(p.metadata.name))
    .sort((a, b) => ordinalOf(a) - ordinalOf(b));
  for (const pod of pods) {
    const role = ordinalOf(pod) === 0 ? 'primary' : 'replica';
    if ((pod.metadata.labels || {})[r.ROLE_LABEL] !== role) {
      await kube.merge('Pod', ns, pod.metadata.name, { metadata: { labels: { [r.ROLE_LABEL]: role } } });
    }
  }

  const domain = (pod) => `${pod.metadata.name}.${n.headless}.${ns}.svc.cluster.local`;
  const primary = pods.find((p) => ordinalOf(p) === 0);
  const primaryReady = !!primary && isReady(primary);
  const instances = [];

  if (primaryReady) {
    try {
      await mysql.ensureReplicationUser(domain(primary), rootPassword, replPassword);
    } catch (e) {
      console.log(`[${name}] utilisateur de réplication: ${e.message}`);
    }
  }

  for (const pod of pods) {
    const role = ordinalOf(pod) === 0 ? 'primary' : 'replica';
    const inst = { name: pod.metadata.name, role, ready: isReady(pod) };
    if (role === 'replica' && inst.ready && primaryReady) {
      try {
        Object.assign(inst, await mysql.ensureReplica(domain(pod), rootPassword, replPassword, domain(primary)));
      } catch (e) {
        inst.replicating = false;
        inst.error = e.message;
      }
    }
    instances.push(inst);
  }

  // Sauvegardes planifiées.
  if (spec.backup.schedule) {
    await kube.apply(r.cronJob(cr, spec, ns, dumpHostFor(name, instances)));
  } else {
    await kube.remove('CronJob', ns, n.cronJob);
  }

  const desired = 1 + spec.replicas;
  const replicas = instances.filter((i) => i.role === 'replica');
  let phase = 'Ready';
  if (pods.length < desired || instances.some((i) => !i.ready)) phase = 'Provisioning';
  else if (replicas.some((i) => !i.replicating)) phase = 'Degraded';

  await setStatus(cr, {
    phase,
    primary: primary ? primary.metadata.name : null,
    readyReplicas: replicas.filter((i) => i.ready && i.replicating).length,
    instances,
    message: '',
  });
}

module.exports = { reconcileCluster, dumpHostFor };
