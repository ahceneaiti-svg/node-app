// Boucle de réconciliation : toutes les RECONCILE_INTERVAL_SECONDS, tous les objets du namespace.
const http = require('http');
const kube = require('./kube');
const { reconcileCluster } = require('./cluster');
const { reconcileBackup, reconcileRestore } = require('./jobs');

const NAMESPACE = process.env.WATCH_NAMESPACE || 'default';
const INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_SECONDS || 10) * 1000;

let lastLoop = Date.now();

async function pass(kind, reconcile) {
  let items;
  try {
    items = await kube.list(kind, NAMESPACE);
  } catch (e) {
    console.error(`liste ${kind}: ${e.message}`);
    return;
  }
  for (const item of items) {
    if (item.metadata.deletionTimestamp) continue;
    try {
      await reconcile(item);
    } catch (e) {
      console.error(`[${kind}/${item.metadata.name}] ${e.message}`);
    }
  }
}

async function main() {
  http
    .createServer((req, res) => {
      const healthy = Date.now() - lastLoop < INTERVAL_MS * 6;
      res.writeHead(healthy ? 200 : 503).end(healthy ? 'ok' : 'boucle bloquée');
    })
    .listen(8081);

  console.log(`opérateur démarré, namespace=${NAMESPACE}, intervalle=${INTERVAL_MS / 1000}s`);
  for (;;) {
    await pass('MySQLCluster', reconcileCluster);
    await pass('MySQLBackup', reconcileBackup);
    await pass('MySQLRestore', reconcileRestore);
    lastLoop = Date.now();
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

main();
