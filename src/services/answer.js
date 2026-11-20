// Answers a question from the conversation's documents (retrieval-augmented), as the chat does.
import config from '../config.js';
import { generateAnswer, generateGeneralAnswer, requestEmbedding, understandMessage } from './llm.js';
import { getSimilarChunksDb, getNeighborChunksDb, getSectionSummariesDb, getAllPassagesDb, getDocumentOverviewsDb } from '../db/chunksQueries.js';
import { figuresInChunks, figuresMentioned, stripFigureMarkers } from './figures.js';

const EXPAND_THRESHOLD = 0.6;
// Whether to read the documents: small talk never does. Otherwise the search runs (it is cheap), and the answer
// skips the documents only when the model judged the message unrelated AND nothing in them scored above
// UNRELATED_MAX, or nothing came close at all. Neither signal is enough alone: the model can't know every detail a
// document holds ("which site has the most women" looked unrelated to it; it scored 0.36), and scores overlap
// ("which company has the most female users", not in the report, also scored 0.35). Unrelated questions (recipes,
// sport, wifi, coding) scored 0.28-0.29. Anything in between is read by the answering model, which flags answers
// the documents don't support.
const UNRELATED_MAX = 0.30;
const NOTHING_CLOSE = 0.25;
const NOT_COVERED_RE = /^\s*your documents (?:don't|do not) cover (?:this|that)[^,.:]*(?:,\s*but\s*|[.:]\s*)/i;

/**
 * Drops the "Your documents don't cover this, but..." opening when an earlier reply already said it, so a
 * conversation about something else doesn't repeat it every turn (the model doesn't skip it reliably itself).
 */
function withoutRepeatedNote(content, history) {
  if (!history.some((m) => m.role === 'assistant' && NOT_COVERED_RE.test(m.content || ''))) return content;
  const rest = content.replace(NOT_COVERED_RE, '');
  return rest === content ? content : rest.charAt(0).toUpperCase() + rest.slice(1);
}
// Passages remembered with an answer: a deck made later in the conversation starts from them.
const SOURCES_KEPT = 8;

// Passages for a whole-document answer, in characters (~16k tokens; with the section summaries, the history and
// the reply it stays inside the 32k context). Longer documents are sampled evenly and shortened.
const WHOLE_DOC_CHARS = 64000;
const SAMPLE_PASSAGES = 40;

/** The documents a whole-document request is about: all when asked, otherwise the ones the search matched best. */
function documentsMeant(allDocuments, docIds, topChunks) {
  if (docIds.length <= 1 || allDocuments || !topChunks.length) return docIds;
  const bestByDoc = new Map();
  for (const c of topChunks) bestByDoc.set(c.document_id, Math.max(bestByDoc.get(c.document_id) ?? 0, c.similarity));
  const top = Math.max(...bestByDoc.values());
  return [...bestByDoc].filter(([, s]) => s >= top - 0.05).map(([id]) => id);
}

// The document's own top-level headings ("3. Financial Performance", "Appendix F. ..."), as a checklist: without
// it the model drops sections whose text sits inside a passage that starts under another heading.
const HEADING_LINE_RE = /^#{1,4}\s+(.+)$/gm;
const TOP_LEVEL_RE = /^(?:\d+\.\s|appendix\s+[a-z0-9]+\b|annex\s|chapter\s)/i;
const MAX_HEADINGS = 40;

function documentHeadings(passages) {
  const all = [];
  for (const p of passages) for (const m of p.content.matchAll(HEADING_LINE_RE)) {
    const h = m[1].trim();
    if (!all.includes(h)) all.push(h);
  }
  const top = all.filter((h) => TOP_LEVEL_RE.test(h));
  return (top.length >= 3 ? top : all).slice(0, MAX_HEADINGS);
}

async function wholeDocumentChunks(docIds) {
  const [sections, passages] = await Promise.all([getSectionSummariesDb(docIds), getAllPassagesDb(docIds)]);
  const total = passages.reduce((n, p) => n + p.content.length, 0);
  let picked = passages;
  if (total > WHOLE_DOC_CHARS) {
    const step = passages.length / SAMPLE_PASSAGES;
    picked = [];
    for (let k = 0; k < passages.length && picked.length < SAMPLE_PASSAGES; k += Math.max(1, step)) picked.push(passages[Math.floor(k)]);
    const each = Math.floor(WHOLE_DOC_CHARS / picked.length);
    picked = picked.map((p) => ({ ...p, content: p.content.slice(0, each) }));
  }
  return {
    headings: documentHeadings(passages),
    chunks: [
      ...sections.map((s) => ({ ...s, content: s.content.replace(/^Summary:[^\n]*\n?/, ''), similarity: 1 })),
      ...picked.map((p) => ({ ...p, level: 'leaf', similarity: 1 })),
    ],
  };
}

/**
 * @param {{ question: string, history: {role, content}[], docIds: number[], onPhase?: (phase) => void,
 *   lastWholeDocument?: number[] }} input  lastWholeDocument: the documents the previous answer covered whole
 * @returns {Promise<{ content: string, grounded: boolean, figures: object[], sourceIds: number[], wholeDocument?: number[] }>}
 */
export async function answerQuestion({ question, history, docIds, onPhase = () => {}, lastWholeDocument }) {
  const again = (lastWholeDocument || []).filter((id) => docIds.includes(id));
  onPhase('rewriting');
  const documents = await getDocumentOverviewsDb(docIds);
  const { query: searchQuery, scope, smallTalk, aboutDocuments, allDocuments } = await understandMessage(
    history, question, { canChangeLast: again.length > 0, documents },
  );
  if (scope === 'change_last_answer' && again.length) return answerWholeDocument(question, history, again, onPhase);

  if (smallTalk && scope === 'specific') return answerFromGeneralKnowledge(question, history, true, onPhase);

  onPhase('searching');
  const topChunks = await getSimilarChunksDb(await requestEmbedding(searchQuery), config.rag.topK, docIds, searchQuery);
  // A whole-document request skips the relevance gate: "give me the gist" matches no passage closely.
  if (scope === 'whole_document') return answerWholeDocument(question, history, documentsMeant(allDocuments, docIds, topChunks), onPhase);
  const best = Math.max(0, ...topChunks.map((c) => c.similarity));
  if (best < NOTHING_CLOSE || (!aboutDocuments && best < UNRELATED_MAX)) {
    return answerFromGeneralKnowledge(question, history, false, onPhase);
  }
  // Strong matches bring their neighbours, so an answer sees the whole passage around a hit.
  const seen = new Set(topChunks.map((c) => c.id));
  const expanded = [...topChunks];
  for (const chunk of topChunks) {
    if (chunk.level !== 'leaf' || chunk.similarity < EXPAND_THRESHOLD) continue;
    for (const n of await getNeighborChunksDb(chunk.id, chunk.document_id, 3)) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      expanded.push({ ...n, similarity: chunk.similarity * 0.9 });
    }
  }
  expanded.sort((a, b) => b.similarity - a.similarity);
  const finalChunks = expanded.slice(0, config.rag.topK + 5);

  onPhase('generating');
  const available = await figuresInChunks(finalChunks);
  // The rewrite is only for retrieval. Answer what the user actually asked; history supplies the context.
  const { llmResponse, grounded } = await generateAnswer(
    question,
    history,
    finalChunks.map((c) => ({ ...c, content: stripFigureMarkers(c.content) })),
    available,
  );
  // Figures shown under the answer: only those it refers to.
  const figures = figuresMentioned(available, llmResponse.content).map((f) => ({
    id: f.id, caption: f.caption, page: f.page, width: f.width, height: f.height, document_id: f.document_id,
  }));
  const sourceIds = finalChunks.filter((c) => c.level === 'leaf' || !c.level).slice(0, SOURCES_KEPT).map((c) => c.id);
  const content = grounded ? llmResponse.content : withoutRepeatedNote(llmResponse.content, history);
  return { content, grounded, figures, sourceIds };
}

async function answerWholeDocument(question, history, docIds, onPhase) {
  const { chunks, headings } = await wholeDocumentChunks(docIds);
  onPhase('generating');
  const { llmResponse } = await generateAnswer(
    question, history, chunks.map((c) => ({ ...c, content: stripFigureMarkers(c.content) })), [], { wholeDocument: headings },
  );
  const leaves = chunks.filter((c) => c.level === 'leaf');
  const step = Math.max(1, leaves.length / SOURCES_KEPT);
  const sourceIds = [];
  for (let k = 0; k < leaves.length && sourceIds.length < SOURCES_KEPT; k += step) sourceIds.push(leaves[Math.floor(k)].id);
  return { content: llmResponse.content, grounded: true, figures: [], sourceIds, wholeDocument: docIds };
}

async function answerFromGeneralKnowledge(question, history, smallTalk, onPhase) {
  onPhase('generating');
  const reply = await generateGeneralAnswer(question, history, { smallTalk });
  return { content: withoutRepeatedNote(reply.content, history), grounded: false, smallTalk, figures: [], sourceIds: [] };
}
