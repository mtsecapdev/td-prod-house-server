import AppError from '../utils/AppError.js';
import pool from './pool.js';

export async function insertAssetDb({ generationId, kind, filePath, mime, title, ownerId }) {
  if (!ownerId) throw new AppError('A Library copy needs an owner', 500);
  const res = await pool.query(
    `INSERT INTO assets (generation_id, kind, file_path, mime, title, owner_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [generationId, kind, filePath, mime, title, ownerId],
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

/** Saved copies, newest first, with the conversation their deck/document/image was made in (if it still exists). */
export async function getAllAssetsDb({ q, kind, ownerId } = {}) {
  let query = `SELECT a.*, g.conversation_id FROM assets a LEFT JOIN generations g ON g.id = a.generation_id
               WHERE a.deleted_at IS NULL AND a.owner_id = $1`;
  const values = [ownerId];
  let i = 2;

  if (kind) {
    query += ` AND a.kind = $${i++}`;
    values.push(kind);
  }
  if (q) {
    query += ` AND a.title ILIKE $${i++}`;
    values.push(`%${q}%`);
  }

  query += ' ORDER BY a.saved_at DESC';
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
