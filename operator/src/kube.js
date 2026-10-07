// Client minimal de l'API Kubernetes (REST + server-side apply), sans dépendance.
// En cluster : ServiceAccount monté dans le pod.
// En local   : KUBE_API=http://127.0.0.1:8001 (kubectl proxy).
const fs = require('fs');
const http = require('http');
const https = require('https');

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const FIELD_MANAGER = 'mysql-operator';
const GROUP = 'mysql.ahceneaiti.dev';
const VERSION = 'v1alpha1';
const CRD_BASE = `/apis/${GROUP}/${VERSION}`;

const KINDS = {
  Service: { base: '/api/v1', plural: 'services' },
  Secret: { base: '/api/v1', plural: 'secrets' },
  Pod: { base: '/api/v1', plural: 'pods' },
  PersistentVolumeClaim: { base: '/api/v1', plural: 'persistentvolumeclaims' },
  StatefulSet: { base: '/apis/apps/v1', plural: 'statefulsets' },
  Job: { base: '/apis/batch/v1', plural: 'jobs' },
  CronJob: { base: '/apis/batch/v1', plural: 'cronjobs' },
  MySQLCluster: { base: CRD_BASE, plural: 'mysqlclusters' },
  MySQLBackup: { base: CRD_BASE, plural: 'mysqlbackups' },
  MySQLRestore: { base: CRD_BASE, plural: 'mysqlrestores' },
};

let conn;
function connection() {
  if (conn) return conn;
  if (process.env.KUBE_API) {
    conn = { url: new URL(process.env.KUBE_API) };
  } else {
    conn = {
      url: new URL(`https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`),
      ca: fs.readFileSync(`${SA_DIR}/ca.crt`),
    };
  }
  return conn;
}

function request(method, path, body, contentType = 'application/json') {
  const { url, ca } = connection();
  const lib = url.protocol === 'https:' ? https : http;
  const headers = { Accept: 'application/json' };
  // Le token est relu à chaque appel : il est renouvelé par kubelet.
  if (ca) headers.Authorization = `Bearer ${fs.readFileSync(`${SA_DIR}/token`, 'utf8').trim()}`;
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = contentType;
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = lib.request(
      { hostname: url.hostname, port: url.port, path, method, headers, ca, timeout: 15000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let data = null;
          try { data = text ? JSON.parse(text) : null; } catch { data = text; }
          resolve({ status: res.statusCode, data });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout API Kubernetes')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function path(kind, ns, name, sub, query) {
  const k = KINDS[kind];
  if (!k) throw new Error(`kind inconnu: ${kind}`);
  let p = `${k.base}/namespaces/${ns}/${k.plural}`;
  if (name) p += `/${name}`;
  if (sub) p += `/${sub}`;
  if (query) p += `?${new URLSearchParams(query)}`;
  return p;
}

function unwrap(res, what) {
  if (res.status >= 200 && res.status < 300) return res.data;
  const err = new Error(`${what}: HTTP ${res.status} ${res.data && res.data.message ? res.data.message : ''}`.trim());
  err.status = res.status;
  throw err;
}

async function get(kind, ns, name) {
  const res = await request('GET', path(kind, ns, name));
  if (res.status === 404) return null;
  return unwrap(res, `get ${kind}/${name}`);
}

async function list(kind, ns, labelSelector) {
  const res = await request('GET', path(kind, ns, null, null, labelSelector ? { labelSelector } : undefined));
  return unwrap(res, `list ${kind}`).items || [];
}

// Server-side apply : crée ou met à jour l'objet de façon idempotente.
async function apply(obj) {
  const kind = obj.kind;
  const { namespace, name } = obj.metadata;
  const res = await request(
    'PATCH',
    path(kind, namespace, name, null, { fieldManager: FIELD_MANAGER, force: 'true' }),
    obj,
    'application/apply-patch+yaml',
  );
  return unwrap(res, `apply ${kind}/${name}`);
}

async function merge(kind, ns, name, body, sub) {
  const res = await request('PATCH', path(kind, ns, name, sub), body, 'application/merge-patch+json');
  return unwrap(res, `patch ${kind}/${name}`);
}

async function remove(kind, ns, name) {
  const res = await request('DELETE', path(kind, ns, name));
  if (res.status === 404) return;
  unwrap(res, `delete ${kind}/${name}`);
}

module.exports = { GROUP, VERSION, get, list, apply, merge, remove };
