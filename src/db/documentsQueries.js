import AppError from '../utils/AppError.js';
import pool from './pool.js';

export async function getAllDocumentsDb(ownerId) {
  try {
    const res = await pool.query(
      'SELECT id, name, file_path, page_count, status, uploaded_at FROM documents WHERE owner_id = $1 ORDER BY uploaded_at DESC',
      [ownerId],
    );
    return res.rows;
  } catch (error) {
    throw new AppError(`Failed to fetch documents: ${error.message}`, 500, error);
  }
}

export async function getDocumentByIdDb(id) {
  const res = await pool.query('SELECT * FROM documents WHERE id = $1', [id]);
  if (res.rowCount === 0) throw new AppError(`Document ${id} not found`, 404);
  return res.rows[0];
}

export async function getDocumentByHashDb(fileHash, ownerId) {
  const res = await pool.query('SELECT * FROM documents WHERE file_hash = $1 AND owner_id = $2', [fileHash, ownerId]);
  return res.rows[0] ?? null;
}

export async function insertDocumentDb(name, { ownerId, filePath, fileHash, pageCount, status = 'processing' } = {}) {
  if (!ownerId) throw new AppError('A document needs an owner', 500);
  try {
    const res = await pool.query(
      `INSERT INTO documents (name, file_path, file_hash, page_count, status, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [name, filePath, fileHash, pageCount, status, ownerId],
    );
    return res.rows[0].id;
  } catch (error) {
    throw new AppError(`Failed to insert document: ${error.message}`, 500, error);
  }
}

export async function updateDocumentStatusDb(id, status, error = null) {
  await pool.query(
    'UPDATE documents SET status = $2, error = $3 WHERE id = $1',
    [id, status, error],
  );
}

export async function documentExistsDb(id) {
  const res = await pool.query('SELECT 1 FROM documents WHERE id = $1', [id]);
  return res.rowCount > 0;
}

export async function deleteDocumentDb(id) {
  let res;
  try {
    res = await pool.query('DELETE FROM documents WHERE id = $1 RETURNING *', [id]);
  } catch (err) {
    throw new AppError(`Failed to delete document: ${err.message}`, 500, err);
  }
  if (res.rowCount === 0) throw new AppError(`Document ${id} not found`, 404);
  return res.rows[0];
}
