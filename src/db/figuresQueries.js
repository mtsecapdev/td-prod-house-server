import pool from './pool.js';

export async function insertFigureDb(documentId, { key, page, caption, labels, filePath, width, height }) {
  await pool.query(
    `INSERT INTO figures (document_id, key, page, caption, labels, file_path, width, height)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (document_id, key) DO NOTHING`,
    [documentId, key, page, caption, labels, filePath, width, height],
  );
}

/** Figures by (document, key) pairs, e.g. those referenced by retrieved passages. */
export async function getFiguresByKeysDb(pairs) {
  if (!pairs.length) return [];
  const res = await pool.query(
    `SELECT f.id, f.document_id, f.key, f.page, f.caption, f.labels, f.width, f.height
     FROM figures f
     JOIN unnest($1::int[], $2::text[]) AS want(document_id, key) USING (document_id, key)`,
    [pairs.map((p) => p.documentId), pairs.map((p) => p.key)],
  );
  return res.rows;
}

export async function getFigureByIdDb(id) {
  const res = await pool.query('SELECT id, document_id, file_path, caption FROM figures WHERE id = $1', [id]);
  return res.rows[0] || null;
}
