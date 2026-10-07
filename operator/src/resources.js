// Construction des objets Kubernetes gérés par l'opérateur.
const { GROUP, VERSION } = require('./kube');

const ROLE_LABEL = 'mysql.ahceneaiti.dev/role';
const API_VERSION = `${GROUP}/${VERSION}`;

function withDefaults(spec) {
  const backup = spec.backup || {};
  return {
    replicas: spec.replicas ?? 1, // nombre de réplicas (slaves), en plus du primaire
    image: spec.image || 'mysql:8.4',
    secretName: spec.secretName || 'mysql-secret',
    storage: spec.storage || '1Gi',
    backup: {
      schedule: backup.schedule || null,
      retention: backup.retention ?? 7,
      storage: backup.storage || '2Gi',
    },
  };
}

function names(name) {
  return {
    primaryService: name,
    readService: `${name}-read`,
    headless: `${name}-headless`,
    backupsPvc: `${name}-backups`,
    cronJob: `${name}-backup`,
  };
}

function selectorLabels(name) {
  return { 'app.kubernetes.io/name': 'mysql', 'app.kubernetes.io/instance': name };
}

function ownerRefs(cr, kind) {
  return [{ apiVersion: API_VERSION, kind, name: cr.metadata.name, uid: cr.metadata.uid, controller: true }];
}

function meta(name, ns, labels, owners) {
  const m = {
    name,
    namespace: ns,
    labels: { ...labels, 'app.kubernetes.io/managed-by': 'mysql-operator' },
  };
  if (owners) m.ownerReferences = owners;
  return m;
}

function service(name, ns, clusterName, owners, { headless = false, role = null } = {}) {
  const selector = { ...selectorLabels(clusterName) };
  if (role) selector[ROLE_LABEL] = role;
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: meta(name, ns, selectorLabels(clusterName), owners),
    spec: {
      ...(headless ? { clusterIP: 'None' } : {}),
      selector,
      ports: [{ name: 'mysql', port: 3306, targetPort: 3306 }],
    },
  };
}

// Script de démarrage : server-id dérivé de l'ordinal, GTID + binlog pour la réplication.
// Les réplicas n'initialisent ni base ni utilisateur applicatif : ils les reçoivent du primaire.
const START_SCRIPT = `ordinal=\${HOSTNAME##*-}
if [ "$ordinal" != "0" ]; then unset MYSQL_DATABASE MYSQL_USER MYSQL_PASSWORD; fi
exec docker-entrypoint.sh mysqld \\
  --server-id=$((100 + ordinal)) \\
  --gtid-mode=ON --enforce-gtid-consistency=ON \\
  --log-bin=mysql-bin --log-replica-updates=ON \\
  --relay-log=relay-bin`;

const PING = 'mysqladmin ping -h 127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD"';

function statefulSet(cr, spec, ns) {
  const name = cr.metadata.name;
  const n = names(name);
  return {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: meta(name, ns, selectorLabels(name), ownerRefs(cr, 'MySQLCluster')),
    spec: {
      serviceName: n.headless,
      replicas: 1 + spec.replicas,
      selector: { matchLabels: selectorLabels(name) },
      template: {
        metadata: { labels: selectorLabels(name) },
        spec: {
          containers: [
            {
              name: 'mysql',
              image: spec.image,
              command: ['sh', '-c', START_SCRIPT],
              ports: [{ containerPort: 3306, name: 'mysql' }],
              envFrom: [{ secretRef: { name: spec.secretName } }],
              readinessProbe: {
                exec: { command: ['sh', '-c', PING] },
                initialDelaySeconds: 15,
                periodSeconds: 5,
              },
              livenessProbe: {
                exec: { command: ['sh', '-c', PING] },
                initialDelaySeconds: 60,
                periodSeconds: 10,
                failureThreshold: 6,
              },
              resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { memory: '512Mi' } },
              volumeMounts: [{ name: 'data', mountPath: '/var/lib/mysql' }],
            },
          ],
        },
      },
      volumeClaimTemplates: [
        {
          metadata: { name: 'data' },
          spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: spec.storage } } },
        },
      ],
    },
  };
}

// Volontairement sans ownerReference : supprimer le cluster ne supprime pas les backups.
function backupsPvc(name, ns, spec) {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: meta(names(name).backupsPvc, ns, selectorLabels(name)),
    spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: spec.backup.storage } } },
  };
}

const DUMP_COMMAND = `mysqldump -h"$DUMP_HOST" -uroot -p"$MYSQL_ROOT_PASSWORD" \\
  --single-transaction --routines --triggers --set-gtid-purged=OFF \\
  --databases "$MYSQL_DATABASE"`;

const BACKUP_SCRIPT = `set -eo pipefail
mkdir -p /backups
${DUMP_COMMAND} | gzip > "/backups/$FILE.tmp"
mv "/backups/$FILE.tmp" "/backups/$FILE"
echo "backup /backups/$FILE ok"`;

const SCHEDULED_SCRIPT = `set -eo pipefail
FILE="scheduled-$(date +%Y%m%d-%H%M%S).sql.gz"
mkdir -p /backups
${DUMP_COMMAND} | gzip > "/backups/$FILE.tmp"
mv "/backups/$FILE.tmp" "/backups/$FILE"
echo "backup /backups/$FILE ok"
for old in $(ls -1t /backups/scheduled-*.sql.gz | tail -n +$((RETENTION + 1))); do
  echo "rotation: suppression de $old"
  rm -f "$old"
done`;

const RESTORE_SCRIPT = `set -eo pipefail
[ -f "/backups/$FILE" ] || { echo "fichier introuvable: /backups/$FILE" >&2; exit 1; }
gunzip -c "/backups/$FILE" | mysql -h"$TARGET_HOST" -uroot -p"$MYSQL_ROOT_PASSWORD"
echo "restore de $FILE ok"`;

function podSpec(spec, clusterName, script, env, readOnlyVolume) {
  return {
    restartPolicy: 'Never',
    containers: [
      {
        name: 'mysql-tools',
        image: spec.image,
        command: ['bash', '-c', script],
        envFrom: [{ secretRef: { name: spec.secretName } }],
        env,
        volumeMounts: [{ name: 'backups', mountPath: '/backups', readOnly: readOnlyVolume }],
      },
    ],
    volumes: [{ name: 'backups', persistentVolumeClaim: { claimName: names(clusterName).backupsPvc } }],
  };
}

function backupJob(cr, cluster, spec, dumpHost) {
  const ns = cr.metadata.namespace;
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: meta(`backup-${cr.metadata.name}`, ns, selectorLabels(cluster.metadata.name), ownerRefs(cr, 'MySQLBackup')),
    spec: {
      backoffLimit: 3,
      template: {
        spec: podSpec(
          spec,
          cluster.metadata.name,
          BACKUP_SCRIPT,
          [
            { name: 'DUMP_HOST', value: dumpHost },
            { name: 'FILE', value: `${cr.metadata.name}.sql.gz` },
          ],
          false,
        ),
      },
    },
  };
}

function restoreJob(cr, cluster, spec, file) {
  const ns = cr.metadata.namespace;
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: meta(`restore-${cr.metadata.name}`, ns, selectorLabels(cluster.metadata.name), ownerRefs(cr, 'MySQLRestore')),
    spec: {
      backoffLimit: 1,
      template: {
        spec: podSpec(
          spec,
          cluster.metadata.name,
          RESTORE_SCRIPT,
          [
            { name: 'TARGET_HOST', value: names(cluster.metadata.name).primaryService },
            { name: 'FILE', value: file },
          ],
          true,
        ),
      },
    },
  };
}

function cronJob(cr, spec, ns, dumpHost) {
  const name = cr.metadata.name;
  return {
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: meta(names(name).cronJob, ns, selectorLabels(name), ownerRefs(cr, 'MySQLCluster')),
    spec: {
      schedule: spec.backup.schedule,
      concurrencyPolicy: 'Forbid',
      successfulJobsHistoryLimit: 3,
      failedJobsHistoryLimit: 3,
      jobTemplate: {
        spec: {
          backoffLimit: 2,
          template: {
            spec: podSpec(
              spec,
              name,
              SCHEDULED_SCRIPT,
              [
                { name: 'DUMP_HOST', value: dumpHost },
                { name: 'RETENTION', value: String(spec.backup.retention) },
              ],
              false,
            ),
          },
        },
      },
    },
  };
}

module.exports = {
  ROLE_LABEL,
  API_VERSION,
  withDefaults,
  names,
  selectorLabels,
  ownerRefs,
  service,
  statefulSet,
  backupsPvc,
  backupJob,
  restoreJob,
  cronJob,
};
