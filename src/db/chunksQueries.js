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

/**
 * The document map used for planning: each document's overview and its section summaries, in reading order.
 * With topicEmbedding and more than `limit` sections, keeps the `limit` sections closest to the topic.
 */
export async function getDocumentMapDb(docIds, { topicEmbedding, limit = 40 } = {}) {
  const overviews = await pool.query(
    `SELECT c.document_id, d.name, c.content
     FROM chunks c JOIN documents d ON d.id = c.document_id
     WHERE c.document_id = ANY($1) AND c.level = 'document'
     ORDER BY c.document_id`,
    [docIds],
  );

  const count = await pool.query(
    `SELECT count(*)::int AS n FROM chunks WHERE document_id = ANY($1) AND level = 'section'`,
    [docIds],
  );
  const ranked = topicEmbedding && count.rows[0].n > limit;

  const sections = ranked
    ? await pool.query(
      `SELECT * FROM (
         SELECT c.id, c.document_id, d.name AS document_name, c.content, c.page, c.heading
         FROM chunks c JOIN documents d ON d.id = c.document_id
         WHERE c.document_id = ANY($1) AND c.level = 'section'
         ORDER BY c.embedding <=> $2 LIMIT $3
       ) s ORDER BY document_id, id`,
      [docIds, pgvector.toSql(topicEmbedding), limit],
    )
    : await pool.query(
      `SELECT c.id, c.document_id, d.name AS document_name, c.content, c.page, c.heading
       FROM chunks c JOIN documents d ON d.id = c.document_id
       WHERE c.document_id = ANY($1) AND c.level = 'section'
       ORDER BY c.document_id, c.id`,
      [docIds],
    );

  return {
    overviews: overviews.rows,
    sections: sections.rows.map((r) => ({ ...r, heading: (r.heading || '').replace(/^Summary:\s*/, '') || 'Section' })),
    truncated: ranked,
  };
}

/** How many summarised sections the documents have (a measure of their size). */
export async function countSectionsDb(docIds) {
  const res = await pool.query(`SELECT count(*)::int AS n FROM chunks WHERE document_id = ANY($1) AND level = 'section'`, [docIds]);
  return res.rows[0].n;
}

/** Each document's name and the start of its overview (what the documents are about, for reading a message). */
export async function getDocumentOverviewsDb(docIds, chars = 240) {
  const res = await pool.query(
    `SELECT d.id, d.name, left(c.content, $2) AS overview
     FROM documents d LEFT JOIN chunks c ON c.document_id = d.id AND c.level = 'document'
     WHERE d.id = ANY($1) ORDER BY d.id`,
    [docIds, chars],
  );
  return res.rows;
}

/** Every section summary of the documents in reading order (for answering about a whole document). */
export async function getSectionSummariesDb(docIds) {
  const res = await pool.query(
    `SELECT id, document_id, content, page, heading, level FROM chunks
     WHERE document_id = ANY($1) AND level = 'section' ORDER BY document_id, id`,
    [docIds],
  );
  return res.rows;
}

/** Every passage of the documents in reading order (for planning a whole-document deck). */
export async function getAllPassagesDb(docIds) {
  const res = await pool.query(
    `SELECT id, document_id, content, page, heading FROM chunks
     WHERE document_id = ANY($1) AND level = 'leaf' ORDER BY document_id, id`,
    [docIds],
  );
  return res.rows;
}

/** Passages (leaf chunks only) for a slide or section, ranked like chat search: meaning + keywords. */
export async function getSourcePassagesDb(queryEmbedding, k, docIds, queryText) {
  const res = await pool.query(
    `SELECT id, document_id, content, page, heading,
       (1 - (embedding <=> $1)) * ${VECTOR_WEIGHT}
       + coalesce(ts_rank(tsv, websearch_to_tsquery('english', $4)), 0) * ${TEXT_WEIGHT} AS similarity
     FROM chunks
     WHERE document_id = ANY($3) AND level = 'leaf'
     ORDER BY similarity DESC
     LIMIT $2`,
    [pgvector.toSql(queryEmbedding), k, docIds, queryText || ''],
  );
  return res.rows;
}

export async function getChunksByIdsDb(ids) {
  if (!ids?.length) return [];
  const res = await pool.query(
    `SELECT id, document_id, content, page, heading FROM chunks WHERE id = ANY($1)`,
    [ids.map(Number)],
  );
  const byId = new Map(res.rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(Number(id))).filter(Boolean); // keep the caller's order
}

/** The passages that contain a figure (by its marker), in reading order. */
export async function getChunksWithFigureDb(documentId, key) {
  const res = await pool.query(
    `SELECT id, document_id, content, page, heading FROM chunks
     WHERE document_id = $1 AND level = 'leaf' AND position($2 in content) > 0
     ORDER BY id`,
    [documentId, `<!-- figure:${key} -->`],
  );
  return res.rows;
}
