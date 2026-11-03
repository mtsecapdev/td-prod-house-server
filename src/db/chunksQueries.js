import pool from './pool.js';
import pgvector from 'pgvector/pg';

export async function insertChunkDb(documentId, content, embedding, { page, heading } = {}) {
  const res = await pool.query(
    'INSERT INTO chunks (document_id, content, embedding, page, heading) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [documentId, content, pgvector.toSql(embedding), page, heading],
  );
  return res.rows[0].id;
}

export async function getSimilarChunksDb(queryEmbedding, k = 5, docIdsToReference) {
  const res = await pool.query(
    `SELECT id, document_id, content, page, heading, 1 - (embedding <=> $1) AS similarity
     FROM chunks
     WHERE document_id = ANY($3)
     ORDER BY embedding <=> $1
     LIMIT $2`,
    [pgvector.toSql(queryEmbedding), k, docIdsToReference],
  );
  return res.rows;
}
