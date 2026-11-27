// Finding text in the documents, for every reader: chat answers, slide/section evidence, outline sources, edits.
// A query is matched against the passages (meaning and keywords); the sections those passages belong to are
// what is returned, so a reader sees a whole section, not a piece of one with its explanation cut off.
import { requestEmbedding } from './llm.js';
import { searchPassagesDb, getSectionPassagesDb } from '../db/chunksQueries.js';

const sectionKey = (p) => `${p.document_id}:${p.section}`;
// A section scoring below this share of the best match is left out: asked about swirl chambers, the combustion
// chamber section scored 0.49 and the next ones (induction, ignition timing) 0.22, which only add noise.
const RELATIVE_FLOOR = 0.6;

/** The passages that best match a query, best first (each with its score as `similarity`). */
export async function findPassages(query, docIds, { k = 8, embedding = null } = {}) {
  if (!docIds?.length || !String(query || '').trim()) return [];
  return searchPassagesDb(embedding || await requestEmbedding(query), k, docIds, query);
}

/**
 * The sections the best-matching passages belong to, best section first, each section's passages in reading
 * order and scored with its best passage's score; sections far below the best match are left out. At most
 * `maxChars` of text: a section that alone would take more than half of that contributes only its matching
 * passages. Returns { passages, best }: best is the top passage score, for judging whether the documents cover
 * the query at all.
 */
export async function findSections(query, docIds, { k = 10, maxChars = 30000, embedding = null } = {}) {
  const hits = await findPassages(query, docIds, { k, embedding });
  if (!hits.length) return { passages: [], best: 0 };
  const order = [];
  const score = new Map();
  for (const h of hits) {
    if (h.similarity < hits[0].similarity * RELATIVE_FLOOR) break;
    const key = sectionKey(h);
    if (!score.has(key)) { order.push(h); score.set(key, h.similarity); }
  }
  const all = await getSectionPassagesDb(order.map((h) => ({ document_id: h.document_id, section: h.section })));
  const bySection = new Map();
  for (const p of all) {
    if (!bySection.has(sectionKey(p))) bySection.set(sectionKey(p), []);
    bySection.get(sectionKey(p)).push(p);
  }
  const passages = [];
  let used = 0;
  for (const h of order) {
    const key = sectionKey(h);
    let parts = bySection.get(key) || [h];
    const size = parts.reduce((n, p) => n + p.content.length, 0);
    if (size > maxChars / 2) parts = parts.filter((p) => hits.some((x) => x.id === p.id));
    const partsSize = parts.reduce((n, p) => n + p.content.length, 0);
    if (passages.length && used + partsSize > maxChars) continue;
    passages.push(...parts.map((p) => ({ ...p, similarity: score.get(key) })));
    used += partsSize;
  }
  return { passages, best: hits[0].similarity };
}
