// Applies src/db/migrations/*.sql in name order, each once, each in its own transaction.
// Run after `npm run table` on a fresh database, and on every deploy: `npm run migrate`.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pool from './pool.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

const client = await pool.connect();
try {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  // One migrator at a time, even with several app instances deploying together.
  await client.query('SELECT pg_advisory_lock(742001)');

  const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf-8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`Applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${err.message}`);
    }
  }
  console.log('Migrations up to date.');
} finally {
  await client.query('SELECT pg_advisory_unlock(742001)').catch(() => {});
  client.release();
  await pool.end();
}
