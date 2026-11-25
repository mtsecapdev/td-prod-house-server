// The facts a plan is built from. The planner quotes, for every point it plans, the words in a passage that
// state it; a point is kept only when that quote is really in the passage and the point's numbers are in the
// quote. Checked here in code, before anything is written, so a slide is never planned on a fact the documents
// don't give, and the writer can be held to the facts instead of having its text deleted afterwards.
import { unsupportedNumbers } from '../factCheck.js';
import { stripFigureMarkers } from '../figures.js';

const normal = (text) => stripFigureMarkers(text).toLowerCase()
  .replace(/\[p\. \d+\]/g, ' ')
  .replace(/[^a-z0-9.%]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// A quote copied with small slips (a dropped word, changed punctuation) still counts when nearly all of its
// words are in the passage and every number in it is.
const SHARED_WORDS = 0.85;

/** Whether `quote` is in `text`, word for word or nearly. */
export function quoteFound(quote, text) {
  const q = normal(quote);
  const t = normal(text);
  if (!q) return false;
  if (t.includes(q)) return true;
  const words = q.split(' ').filter((w) => w.length > 2);
  if (words.length < 3) return false;
  const have = new Set(t.split(' '));
  const shared = words.filter((w) => have.has(w)).length / words.length;
  return shared >= SHARED_WORDS && !unsupportedNumbers(quote, text).length;
}

/**
 * The planned points that hold up, as facts: { point, quote, chunk_id, document_id, page }. raw: [{ point, quote, source }];
 * source is a passage id (0: the user's own text). passagesById: Map of the passages the planner was shown.
 */
export function verifiedFacts(raw, passagesById, ownText = '') {
  const facts = [];
  const seen = new Set();
  for (const r of raw || []) {
    const point = String(r.point || '').replace(/\s*\[(?:p\. )?\d+(?:\s*,\s*\d+)*\]/g, '').trim();
    const quote = String(r.quote || '').trim();
    if (!point || !quote || seen.has(point.toLowerCase())) continue;
    // The quote must be in the passage it names; the model sometimes names the wrong one of those it was shown,
    // so the others are tried too.
    let passage = passagesById.get(Number(r.source));
    if (passage && !quoteFound(quote, passage.content)) passage = null;
    if (!passage && !(ownText && quoteFound(quote, ownText))) {
      passage = [...passagesById.values()].find((p) => quoteFound(quote, p.content));
      if (!passage) continue;
    }
    if (unsupportedNumbers(point, quote).length) continue;
    seen.add(point.toLowerCase());
    facts.push({ point, quote, chunk_id: passage?.id ?? null, document_id: passage?.document_id ?? null, page: passage?.page ?? null });
  }
  return facts;
}

/** The facts as the writer reads them: the quoted words, with their page. */
export function factsBlock(facts) {
  return facts.map((f) => `- ${f.quote}${f.page != null ? ` [p. ${f.page}]` : ''}`).join('\n');
}
