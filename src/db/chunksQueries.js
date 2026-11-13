import pool from './pool.js';
import pgvector from 'pgvector/pg';

export async function insertChunkDb(documentId, content, embedding, { page, heading, level } = {}) {
  const res = await pool.query(
    'INSERT INTO chunks (document_id, content, embedding, page, heading, level) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [documentId, content, pgvector.toSql(embedding), page, heading, level || 'leaf'],
  );
  return res.rows[0].id;
}

const VECTOR_WEIGHT = 0.7;
const TEXT_WEIGHT = 0.3;
const MAX_SUMMARY_CHUNKS = 3;
const FETCH_MULTIPLIER = 2;

export async function getSimilarChunksDb(queryEmbedding, k = 10, docIdsToReference, queryText) {
  const hasQuery = queryText && queryText.trim().length > 0;
  const fetchK = k * FETCH_MULTIPLIER;

  const sql = hasQuery
    ? `SELECT id, document_id, content, page, heading, level,
         (1 - (embedding <=> $1)) * ${VECTOR_WEIGHT}
         + coalesce(ts_rank(tsv, websearch_to_tsquery('english', $4)), 0) * ${TEXT_WEIGHT}
         AS similarity
       FROM chunks
       WHERE document_id = ANY($3)
       ORDER BY similarity DESC
       LIMIT $2`
    : `SELECT id, document_id, content, page, heading, level,
         (1 - (embedding <=> $1)) AS similarity
       FROM chunks
       WHERE document_id = ANY($3)
       ORDER BY similarity DESC
       LIMIT $2`;

  const params = hasQuery
    ? [pgvector.toSql(queryEmbedding), fetchK, docIdsToReference, queryText]
    : [pgvector.toSql(queryEmbedding), fetchK, docIdsToReference];

  const res = await pool.query(sql, params);

  const result = [];
  let summaryCount = 0;
  for (const row of res.rows) {
    if (row.level !== 'leaf') {
      if (summaryCount >= MAX_SUMMARY_CHUNKS) continue;
      summaryCount++;
    }
    result.push(row);
    if (result.length >= k) break;
  }
  return result;
}

export async function getNeighborChunksDb(chunkId, documentId, radius = 3) {
  const res = await pool.query(
    `SELECT id, document_id, content, page, heading, level, 0::float AS similarity
     FROM chunks
     WHERE document_id = $2::int
       AND level = 'leaf'
       AND id BETWEEN ($1::int - $3::int) AND ($1::int + $3::int)
       AND id != $1::int
     ORDER BY id`,
    [chunkId, documentId, radius],
  );
  return res.rows;
}
