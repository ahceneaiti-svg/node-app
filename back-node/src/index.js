const express = require('express');
const { pool, init } = require('./db');

const app = express();
app.use(express.json());

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(body, partial = false) {
  const { name, email } = body || {};
  if (!partial || name !== undefined) {
    if (typeof name !== 'string' || !name.trim() || name.length > 100) return 'name invalide';
  }
  if (!partial || email !== undefined) {
    if (typeof email !== 'string' || !EMAIL_RE.test(email) || email.length > 255) return 'email invalide';
  }
  if (partial && name === undefined && email === undefined) return 'name ou email requis';
  return null;
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'db indisponible' });
  }
});

app.get('/users', async (_req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM users ORDER BY id');
    res.json(rows);
  } catch (e) { next(e); }
});

app.get('/users/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'utilisateur introuvable' });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

app.post('/users', async (req, res, next) => {
  const err = validate(req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { name, email } = req.body;
    const [r] = await pool.query('INSERT INTO users (name, email) VALUES (?, ?)', [name.trim(), email]);
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [r.insertId]);
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

app.put('/users/:id', async (req, res, next) => {
  const err = validate(req.body, true);
  if (err) return res.status(400).json({ error: err });
  try {
    const fields = [];
    const values = [];
    if (req.body.name !== undefined) { fields.push('name = ?'); values.push(req.body.name.trim()); }
    if (req.body.email !== undefined) { fields.push('email = ?'); values.push(req.body.email); }
    const [r] = await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, [...values, req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'utilisateur introuvable' });
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

app.delete('/users/:id', async (req, res, next) => {
  try {
    const [r] = await pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'utilisateur introuvable' });
    res.status(204).end();
  } catch (e) { next(e); }
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'email déjà utilisé' });
  console.error(err);
  res.status(500).json({ error: 'erreur interne' });
});

const port = Number(process.env.PORT || 3000);
init()
  .then(() => app.listen(port, () => console.log(`API sur :${port}`)))
  .catch((e) => { console.error(e.message); process.exit(1); });
