import pool from './pool.js';
import AppError from '../utils/AppError.js';

const COLUMNS = 'id, conversation_id, role, kind, content, data, created_at';

export async function listMessagesDb(conversationId) {
  const res = await pool.query(`SELECT ${COLUMNS} FROM messages WHERE conversation_id = $1 ORDER BY id`, [conversationId]);
  return res.rows;
}

export async function insertMessageDb(conversationId, { role, kind = 'text', content = '', data = {} }) {
  const res = await pool.query(
    `INSERT INTO messages (conversation_id, role, kind, content, data) VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
    [conversationId, role, kind, content, JSON.stringify(data)],
  );
  await pool.query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [conversationId]);
  return res.rows[0];
}

export async function getMessageDb(conversationId, id) {
  const res = await pool.query(`SELECT ${COLUMNS} FROM messages WHERE conversation_id = $1 AND id = $2`, [conversationId, id]);
  if (!res.rowCount) throw new AppError('Message not found', 404);
  return res.rows[0];
}

/** Merges `patch` into the message's data. */
export async function updateMessageDataDb(id, patch) {
  const res = await pool.query(
    `UPDATE messages SET data = data || $2::jsonb WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, JSON.stringify(patch)],
  );
  return res.rows[0];
}
