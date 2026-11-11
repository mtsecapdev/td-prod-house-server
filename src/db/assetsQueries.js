import AppError from '../utils/AppError.js';
import pool from './pool.js';

export async function insertAssetDb({ generationId, kind, filePath, mime, title }) {
  const res = await pool.query(
    `INSERT INTO assets (generation_id, kind, file_path, mime, title)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [generationId, kind, filePath, mime, title],
  );
  return res.rows[0].id;
}

export async function getAssetsByGenerationDb(generationId) {
  const res = await pool.query(
    'SELECT * FROM assets WHERE generation_id = $1 AND deleted_at IS NULL',
    [generationId],
  );
  return res.rows;
}

export async function getAssetByIdDb(id) {
  const res = await pool.query('SELECT * FROM assets WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (res.rowCount === 0) throw new AppError(`Asset ${id} not found`, 404);
  return res.rows[0];
}

export async function getAllAssetsDb({ q, kind } = {}) {
  let query = 'SELECT * FROM assets WHERE deleted_at IS NULL';
  const values = [];
  let i = 1;

  if (kind) {
    query += ` AND kind = $${i++}`;
    values.push(kind);
  }
  if (q) {
    query += ` AND title ILIKE $${i++}`;
    values.push(`%${q}%`);
  }

  query += ' ORDER BY saved_at DESC';
  const res = await pool.query(query, values);
  return res.rows;
}

export async function softDeleteAssetDb(id) {
  const res = await pool.query(
    'UPDATE assets SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *',
    [id],
  );
  if (res.rowCount === 0) throw new AppError(`Asset ${id} not found`, 404);
  return res.rows[0];
}
