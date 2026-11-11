import AppError from '../utils/AppError.js';
import pool from './pool.js';

export async function insertGenerationDb({ type, brief, sourceDocumentIds, model, settings }) {
  const res = await pool.query(
    `INSERT INTO generations (type, brief, source_document_ids, model, settings)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [type, brief, sourceDocumentIds, model, settings],
  );
  return res.rows[0].id;
}

export async function getGenerationByIdDb(id) {
  const res = await pool.query('SELECT * FROM generations WHERE id = $1', [id]);
  if (res.rowCount === 0) throw new AppError(`Generation ${id} not found`, 404);
  return res.rows[0];
}

export async function updateGenerationDb(id, fields) {
  const sets = [];
  const values = [];
  let i = 1;

  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = $${i++}`);
    values.push(value);
  }

  sets.push(`updated_at = NOW()`);
  values.push(id);

  await pool.query(
    `UPDATE generations SET ${sets.join(', ')} WHERE id = $${i}`,
    values,
  );
}

export async function getAllGenerationsDb() {
  const res = await pool.query(
    'SELECT id, type, status, brief, created_at, updated_at FROM generations ORDER BY created_at DESC',
  );
  return res.rows;
}

export async function deleteGenerationDb(id) {
  const res = await pool.query('DELETE FROM generations WHERE id = $1', [id]);
  if (res.rowCount === 0) throw new AppError(`Generation ${id} not found`, 404);
}
