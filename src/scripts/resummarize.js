// Rewrites the overview of imported documents (after an overview change) and drops their stored section
// summaries, which are written again the next time a whole-document answer needs them.
// Usage: npm run resummarize -- <documentId> [<documentId> ...]
import pool from '../db/pool.js';
import { writeOverview } from '../services/summarizer.js';

const ids = process.argv.slice(2).map(Number).filter(Number.isInteger);
if (!ids.length) {
  console.error('Usage: npm run resummarize -- <documentId> [<documentId> ...]');
  process.exit(1);
}

for (const docId of ids) {
  const old = await pool.query(`SELECT id FROM chunks WHERE document_id = $1 AND level IN ('section', 'document')`, [docId]);
  const started = Date.now();
  await writeOverview(docId);
  await pool.query('DELETE FROM chunks WHERE id = ANY($1)', [old.rows.map((r) => r.id)]);
  console.log(`Document ${docId}: overview rewritten in ${((Date.now() - started) / 1000).toFixed(0)} s (replaced ${old.rowCount})`);
}
await pool.end();
