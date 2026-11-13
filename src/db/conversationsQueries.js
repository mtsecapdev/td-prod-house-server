import pool from './pool.js';
import AppError from '../utils/AppError.js';

export async function listConversationsDb() {
  const res = await pool.query(
    'SELECT id, title, doc_ids, created_at, updated_at FROM conversations ORDER BY updated_at DESC',
  );
  return res.rows;
}

export async function getConversationDb(id) {
  const res = await pool.query('SELECT * FROM conversations WHERE id = $1', [id]);
  if (res.rowCount === 0) throw new AppError(`Conversation ${id} not found`, 404);
  return res.rows[0];
}

export async function createConversationDb(title, docIds) {
  const res = await pool.query(
    `INSERT INTO conversations (title, doc_ids) VALUES ($1, $2) RETURNING *`,
    [title, docIds],
  );
  return res.rows[0];
}

export async function updateConversationDb(id, { title, messages, docIds }) {
  const sets = ['updated_at = NOW()'];
  const vals = [];
  let idx = 1;

  if (title !== undefined) { sets.push(`title = $${idx++}`); vals.push(title); }
  if (messages !== undefined) { sets.push(`messages = $${idx++}`); vals.push(JSON.stringify(messages)); }
  if (docIds !== undefined) { sets.push(`doc_ids = $${idx++}`); vals.push(docIds); }

  vals.push(id);
  const res = await pool.query(
    `UPDATE conversations SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    vals,
  );
  if (res.rowCount === 0) throw new AppError(`Conversation ${id} not found`, 404);
  return res.rows[0];
}

export async function deleteConversationDb(id) {
  const res = await pool.query('DELETE FROM conversations WHERE id = $1 RETURNING id', [id]);
  if (res.rowCount === 0) throw new AppError(`Conversation ${id} not found`, 404);
  return res.rows[0];
}
