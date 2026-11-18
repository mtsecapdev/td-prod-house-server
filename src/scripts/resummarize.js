// Rebuilds the section summaries and document overview of ingested documents (after a summarizer change).
// New summaries are written before the old ones are removed, so a failure part-way leaves the old set intact.
// Usage: npm run resummarize -- <documentId> [<documentId> ...]
import pool from '../db/pool.js';
import { generateSummaryChunks } from '../services/summarizer.js';

const ids = process.argv.slice(2).map(Number).filter(Number.isInteger);
if (!ids.length) {
  console.error('Usage: npm run resummarize -- <documentId> [<documentId> ...]');
  process.exit(1);
}

for (const docId of ids) {
  const old = await pool.query(`SELECT id FROM chunks WHERE document_id = $1 AND level IN ('section', 'document')`, [docId]);
  const leaves = await pool.query(
    `SELECT content AS text, page, heading FROM chunks WHERE document_id = $1 AND level = 'leaf' ORDER BY id`,
    [docId],
  );
  if (!leaves.rowCount) {
    console.error(`Document ${docId}: no passages, skipped`);
    continue;
  }
  const started = Date.now();
  const { sectionCount } = await generateSummaryChunks(docId, leaves.rows);
  await pool.query('DELETE FROM chunks WHERE id = ANY($1)', [old.rows.map((r) => r.id)]);
  console.log(`Document ${docId}: ${sectionCount} section summaries + overview in ${((Date.now() - started) / 1000).toFixed(0)} s (replaced ${old.rowCount})`);
}
await pool.end();
