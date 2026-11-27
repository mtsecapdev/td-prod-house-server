// Passages of the documents, and what is stored beside them. A document is stored as:
// - leaf passages: its text, one per section (a long section in several parts), each with its page, heading,
//   section number and embedding. Everything that reads or searches a document uses these.
// - one document overview (level 'document'): a paragraph on what the document is about.
// - section summaries (level 'section'): written only when a whole-document answer needs them for a document
//   too long to read in full (wholeDocument.js); never searched, never used as evidence.
import pool from './pool.js';
import pgvector from 'pgvector/pg';

const PASSAGE_COLUMNS = 'id, document_id, content, page, heading, section';

export async function insertChunkDb(documentId, content, embedding, { page, heading, level, section } = {}) {
  const res = await pool.query(
    'INSERT INTO chunks (document_id, content, embedding, page, heading, level, section) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [documentId, content, embedding ? pgvector.toSql(embedding) : null, page, heading, level || 'leaf', section ?? null],
  );
  return res.rows[0].id;
}

// Search score: meaning (embedding similarity) and wording (keyword rank) together.
const VECTOR_WEIGHT = 0.7;
const TEXT_WEIGHT = 0.3;

/**
 * The passages of the documents that best match a query (meaning and keywords), best first, with their score.
 * Every passage of the selected documents is scored exactly (the documents index finds them).
 */
export async function searchPassagesDb(queryEmbedding, k, docIds, queryText) {
  const res = await pool.query(
    `SELECT ${PASSAGE_COLUMNS},
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

/** Every passage of the given sections ([{ document_id, section }]), in reading order. */
export async function getSectionPassagesDb(sections) {
  if (!sections.length) return [];
  const res = await pool.query(
    `SELECT ${PASSAGE_COLUMNS} FROM chunks
     JOIN unnest($1::int[], $2::int[]) AS want(document_id, section) USING (document_id, section)
     WHERE level = 'leaf'
     ORDER BY document_id, id`,
    [sections.map((s) => s.document_id), sections.map((s) => s.section)],
  );
  return res.rows;
}

/** Every passage of the documents, in reading order. */
export async function getAllPassagesDb(docIds) {
  const res = await pool.query(
    `SELECT ${PASSAGE_COLUMNS} FROM chunks
     WHERE document_id = ANY($1) AND level = 'leaf' ORDER BY document_id, id`,
    [docIds],
  );
  return res.rows;
}

export async function getChunksByIdsDb(ids) {
  if (!ids?.length) return [];
  const res = await pool.query(`SELECT ${PASSAGE_COLUMNS} FROM chunks WHERE id = ANY($1)`, [ids.map(Number)]);
  const byId = new Map(res.rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(Number(id))).filter(Boolean); // keep the caller's order
}

/** The passages that contain a figure (by its marker), in reading order. */
export async function getChunksWithFigureDb(documentId, key) {
  const res = await pool.query(
    `SELECT ${PASSAGE_COLUMNS} FROM chunks
     WHERE document_id = $1 AND level = 'leaf' AND position($2 in content) > 0
     ORDER BY id`,
    [documentId, `<!-- figure:${key} -->`],
  );
  return res.rows;
}

/** The documents' sections in reading order: heading and the page each starts on. */
export async function getSectionListDb(docIds) {
  const res = await pool.query(
    `SELECT document_id, section, min(heading) AS heading, min(page) AS page
     FROM chunks WHERE document_id = ANY($1) AND level = 'leaf'
     GROUP BY document_id, section ORDER BY document_id, min(id)`,
    [docIds],
  );
  return res.rows;
}

/** How many sections the documents have (a measure of their size). */
export async function countSectionsDb(docIds) {
  const res = await pool.query(
    `SELECT count(DISTINCT (document_id, section))::int AS n FROM chunks WHERE document_id = ANY($1) AND level = 'leaf'`,
    [docIds],
  );
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

/** A document's section summaries in reading order (written on demand: see wholeDocument.js). */
export async function getSectionSummariesDb(docIds) {
  const res = await pool.query(
    `SELECT ${PASSAGE_COLUMNS}, level FROM chunks
     WHERE document_id = ANY($1) AND level = 'section' ORDER BY document_id, id`,
    [docIds],
  );
  return res.rows;
}
