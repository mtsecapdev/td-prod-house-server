// Answers a question from the conversation's documents (retrieval-augmented), as the chat does.
import config from '../config.js';
import { generateAnswer, generateGeneralAnswer, requestEmbedding, rewriteQuery } from './llm.js';
import { getSimilarChunksDb, getNeighborChunksDb, getSectionSummariesDb, getAllPassagesDb } from '../db/chunksQueries.js';
import { figuresInChunks, figuresMentioned, stripFigureMarkers } from './figures.js';

const EXPAND_THRESHOLD = 0.6;
// Below this best-match score nothing in the documents is close, so the model answers from general knowledge
// without reading excerpts. Calibrated on 21 questions over three documents: answerable ones scored 0.38-0.79,
// unrelated ones (a cake recipe, Python, "hi") 0.26-0.33. Loosely worded real questions score close to unrelated
// ones ("How did the defence business do?" 0.38, a running question 0.37), so the line stays low: it never
// skipped an answerable question in the test, and caught 6 of 7 unrelated ones.
const RELEVANCE_MIN = 0.35;
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

// "Summarise the whole report", "what was covered in that document": the best few passages can't answer these,
// so the answer reads the document's section summaries and passages instead. A summary of one part
// ("summarise section 3", "...the risks") stays a normal search.
const SUMMARY_RE = /\b(summar(?:y|ies|ise|ize|ised|ized)|overview|recap|outline|tl;?dr|key (?:points|takeaways)|go through)\b/i;
const WHOLE_RE = /\b(whole|entire|full|comprehensive|complete|everything|all of it|documents?|docs?|reports?|pdfs?|files?|manuals?|guides?|papers?|handbooks?)\b/i;
const COVERED_RE = /\bwhat(?:'s| is| was| does| did)?\b.*\b(?:covered|cover|in (?:the|this|that|it)\b.*\b(?:document|doc|report|pdf|file|manual))\b/i;
const PART_RE = /\b(section|chapter|appendix|page|part)\b/i;
const ALL_DOCS_RE = /\b(all|each|every|both|these|those) (?:of )?(?:the |my )?(documents|docs|reports|files|manuals|pdfs)\b/i;
// Passages for a whole-document answer, in characters (~16k tokens; with the section summaries, the history and
// the reply it stays inside the 32k context). Longer documents are sampled evenly and shortened.
const WHOLE_DOC_CHARS = 64000;
const SAMPLE_PASSAGES = 40;

// A short instruction right after a whole-document answer ("include references", "make it shorter", "in bullet
// points") changes that answer, so it reads the same documents again. A question ("what about the dividend?")
// is a new search.
const REVISION_RE = /^\s*(?:please\s+|pls\s+|can you\s+|could you\s+|now\s+|ok(?:ay)?,?\s+)?(?:include|add|make|shorten|expand|rewrite|redo|reformat|format|put|use|cite|give (?:it|me it|me that)|turn|condense|simplify|translate|drop|remove|keep|split|do (?:it|that)|with|without|in|as|more|less|shorter|longer|briefer)\b/i;
const QUESTION_WORD_RE = /\b(what|which|who|whom|whose|why|when|where|how)\b/i;
const REVISION_MAX_WORDS = 14;

export function isRevision(question) {
  return REVISION_RE.test(question) && !QUESTION_WORD_RE.test(question)
    && question.trim().split(/\s+/).length <= REVISION_MAX_WORDS;
}

export function isWholeDocumentRequest(question) {
  if (PART_RE.test(question)) return false;
  return (SUMMARY_RE.test(question) && WHOLE_RE.test(question)) || COVERED_RE.test(question);
}

/** The documents a whole-document request is about: all, when it says so; otherwise the ones the search matched best. */
function documentsMeant(question, docIds, topChunks) {
  if (docIds.length <= 1 || ALL_DOCS_RE.test(question)) return docIds;
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
  const again = lastWholeDocument?.filter((id) => docIds.includes(id));
  if (again?.length && isRevision(question)) return answerWholeDocument(question, history, again, onPhase);

  onPhase('rewriting');
  const searchQuery = await rewriteQuery(history, question);

  onPhase('searching');
  const topChunks = await getSimilarChunksDb(await requestEmbedding(searchQuery), config.rag.topK, docIds, searchQuery);
  const best = Math.max(0, ...topChunks.map((c) => c.similarity));
  if (best < RELEVANCE_MIN) {
    onPhase('generating');
    const reply = await generateGeneralAnswer(question, history);
    return { content: withoutRepeatedNote(reply.content, history), grounded: false, figures: [], sourceIds: [] };
  }
  if (isWholeDocumentRequest(question)) {
    return answerWholeDocument(question, history, documentsMeant(question, docIds, topChunks), onPhase);
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
