import pool from './pool.js';
import AppError from '../utils/AppError.js';

const COLUMNS = 'id, title, doc_ids, created_at, updated_at';

/** Conversations, most recently active first, with the kinds of things made in each (deck, doc, image). */
export async function listConversationsDb() {
  const res = await pool.query(
    `SELECT c.id, c.title, c.doc_ids, c.created_at, c.updated_at,
            COALESCE((SELECT array_agg(DISTINCT g.type) FROM generations g WHERE g.conversation_id = c.id), '{}') AS made
     FROM conversations c ORDER BY c.updated_at DESC`,
  );
  return res.rows;
}

export async function getConversationDb(id) {
  const res = await pool.query(`SELECT ${COLUMNS} FROM conversations WHERE id = $1`, [id]);
  if (res.rowCount === 0) throw new AppError(`Conversation ${id} not found`, 404);
  return res.rows[0];
}

export async function createConversationDb(title, docIds) {
  const res = await pool.query(
    `INSERT INTO conversations (title, doc_ids) VALUES ($1, $2) RETURNING ${COLUMNS}`,
    [title, docIds],
  );
  return res.rows[0];
}

export async function updateConversationDb(id, { title, docIds }) {
  const sets = ['updated_at = NOW()'];
  const vals = [];
  if (title !== undefined) { vals.push(title); sets.push(`title = $${vals.length}`); }
  if (docIds !== undefined) { vals.push(docIds); sets.push(`doc_ids = $${vals.length}`); }
  vals.push(id);
  const res = await pool.query(
    `UPDATE conversations SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING ${COLUMNS}`,
    vals,
  );
  if (res.rowCount === 0) throw new AppError(`Conversation ${id} not found`, 404);
  return res.rows[0];
}

/** Deletes the conversation and the decks/documents made in it; returns their ids (for file clean-up). */
export async function deleteConversationDb(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const made = await client.query('DELETE FROM generations WHERE conversation_id = $1 RETURNING id', [id]);
    const res = await client.query('DELETE FROM conversations WHERE id = $1 RETURNING id', [id]);
    if (res.rowCount === 0) throw new AppError(`Conversation ${id} not found`, 404);
    await client.query('COMMIT');
    return made.rows.map((r) => r.id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Links a deck/document made outside a conversation to one (older items opened from the Library). */
export async function adoptGenerationDb(conversationId, generationId) {
  await pool.query('UPDATE generations SET conversation_id = $1 WHERE id = $2', [conversationId, generationId]);
}
