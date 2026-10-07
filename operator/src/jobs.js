// Réconciliation des MySQLBackup et MySQLRestore : un Job par ressource.
const kube = require('./kube');
const r = require('./resources');
const { dumpHostFor } = require('./cluster');

const TERMINAL = ['Completed', 'Failed'];

async function setStatus(kind, cr, status) {
  const current = cr.status || {};
  if (Object.keys(status).every((k) => JSON.stringify(current[k]) === JSON.stringify(status[k]))) return;
  await kube.merge(kind, cr.metadata.namespace, cr.metadata.name, { status }, 'status');
}

function jobPhase(job) {
  const conditions = (job.status && job.status.conditions) || [];
  if (conditions.some((c) => c.type === 'Complete' && c.status === 'True')) return 'Completed';
  if (conditions.some((c) => c.type === 'Failed' && c.status === 'True')) return 'Failed';
  return 'Running';
}

function jobStatus(job, phase, jobName) {
  return {
    phase,
    jobName,
    startTime: job.status && job.status.startTime,
    completionTime: job.status && job.status.completionTime,
    message: phase === 'Failed' ? `job en échec: kubectl logs job/${jobName}` : '',
  };
}

async function reconcileBackup(cr) {
  if (TERMINAL.includes(cr.status && cr.status.phase)) return;
  const ns = cr.metadata.namespace;
  const cluster = await kube.get('MySQLCluster', ns, cr.spec.clusterName);
  if (!cluster) return setStatus('MySQLBackup', cr, { phase: 'Failed', message: `cluster ${cr.spec.clusterName} introuvable` });

  const spec = r.withDefaults(cluster.spec || {});
  const jobName = `backup-${cr.metadata.name}`;
  let job = await kube.get('Job', ns, jobName);
  if (!job) {
    const dumpHost = dumpHostFor(cluster.metadata.name, cluster.status && cluster.status.instances);
    job = await kube.apply(r.backupJob(cr, cluster, spec, dumpHost));
  }
  const phase = jobPhase(job);
  await setStatus('MySQLBackup', cr, { ...jobStatus(job, phase, jobName), file: `${cr.metadata.name}.sql.gz` });
}

async function reconcileRestore(cr) {
  if (TERMINAL.includes(cr.status && cr.status.phase)) return;
  const ns = cr.metadata.namespace;
  const cluster = await kube.get('MySQLCluster', ns, cr.spec.clusterName);
  if (!cluster) return setStatus('MySQLRestore', cr, { phase: 'Failed', message: `cluster ${cr.spec.clusterName} introuvable` });

  let file = cr.spec.file;
  if (!file) {
    if (!cr.spec.backupName) return setStatus('MySQLRestore', cr, { phase: 'Failed', message: 'backupName ou file requis' });
    const backup = await kube.get('MySQLBackup', ns, cr.spec.backupName);
    if (!backup) return setStatus('MySQLRestore', cr, { phase: 'Failed', message: `backup ${cr.spec.backupName} introuvable` });
    if (backup.status && backup.status.phase === 'Failed') {
      return setStatus('MySQLRestore', cr, { phase: 'Failed', message: `backup ${cr.spec.backupName} en échec` });
    }
    if (!backup.status || backup.status.phase !== 'Completed') {
      return setStatus('MySQLRestore', cr, { phase: 'Pending', message: `attente du backup ${cr.spec.backupName}` });
    }
    file = backup.status.file;
  }

  const spec = r.withDefaults(cluster.spec || {});
  const jobName = `restore-${cr.metadata.name}`;
  let job = await kube.get('Job', ns, jobName);
  if (!job) job = await kube.apply(r.restoreJob(cr, cluster, spec, file));
  const phase = jobPhase(job);
  await setStatus('MySQLRestore', cr, { ...jobStatus(job, phase, jobName), file });
}

module.exports = { reconcileBackup, reconcileRestore };
