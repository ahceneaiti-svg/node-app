// Gestion de la réplication MySQL (GTID) via SQL.
const mysql = require('mysql2/promise');

async function withConnection(host, password, fn) {
  const conn = await mysql.createConnection({ host, user: 'root', password, connectTimeout: 5000 });
  try {
    return await fn(conn);
  } finally {
    await conn.end().catch(() => {});
  }
}

// Crée l'utilisateur de réplication sur le primaire (une seule fois, pas de rotation).
function ensureReplicationUser(host, rootPassword, replPassword) {
  return withConnection(host, rootPassword, async (c) => {
    const [rows] = await c.query("SELECT 1 FROM mysql.user WHERE user = 'repl' AND host = '%'");
    if (rows.length) return;
    await c.query("CREATE USER 'repl'@'%' IDENTIFIED BY ?", [replPassword]);
    await c.query("GRANT REPLICATION SLAVE ON *.* TO 'repl'@'%'");
  });
}

// Configure et surveille la réplication d'un réplica. Retourne son état.
function ensureReplica(host, rootPassword, replPassword, primaryHost) {
  return withConnection(host, rootPassword, async (c) => {
    let [[status]] = await c.query('SHOW REPLICA STATUS');

    if (!status || status.Source_Host !== primaryHost) {
      await c.query('STOP REPLICA');
      // Première configuration : on repart d'un historique GTID vide (cf. README opérateur).
      const [[gtid]] = await c.query('SELECT @@GLOBAL.gtid_executed AS g');
      if (!status && gtid.g) await c.query('RESET BINARY LOGS AND GTIDS');
      await c.query(
        `CHANGE REPLICATION SOURCE TO SOURCE_HOST = ?, SOURCE_USER = 'repl', SOURCE_PASSWORD = ?,
         SOURCE_AUTO_POSITION = 1, GET_SOURCE_PUBLIC_KEY = 1`,
        [primaryHost, replPassword],
      );
      await c.query('START REPLICA');
    } else if (status.Replica_IO_Running === 'No' && status.Replica_SQL_Running === 'No') {
      await c.query('START REPLICA');
    }

    // Un réplica ne doit jamais accepter d'écriture applicative (non persistant : réappliqué à chaque cycle).
    const [[ro]] = await c.query('SELECT @@GLOBAL.super_read_only AS r');
    if (!ro.r) await c.query('SET GLOBAL super_read_only = ON');

    [[status]] = await c.query('SHOW REPLICA STATUS');
    const replicating = !!status && status.Replica_IO_Running === 'Yes' && status.Replica_SQL_Running === 'Yes';
    return {
      replicating,
      lagSeconds: status && status.Seconds_Behind_Source !== null ? Number(status.Seconds_Behind_Source) : null,
      error: (status && (status.Last_IO_Error || status.Last_SQL_Error)) || null,
    };
  });
}

module.exports = { ensureReplicationUser, ensureReplica };
