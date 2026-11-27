// Answers a question from the conversation's documents (retrieval-augmented), as the chat does.
import config from '../config.js';
import { generateAnswer, generateGeneralAnswer, generateStructured, understandMessage } from './llm.js';
import { quoteFound } from './planning/facts.js';
import { getDocumentOverviewsDb } from '../db/chunksQueries.js';
import { findSections } from './retrieval.js';
import { coverDocuments } from './wholeDocument.js';
import { figuresInChunks, figuresMentioned, stripFigureMarkers } from './figures.js';

// Text an answer reads at most: the sections its best matches belong to (whole, so an explanation is never cut
// off mid-way).
const ANSWER_CHARS = 30000;
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
const MAX_LIST_ITEMS = 15;

/**
 * For a question asking for a set of things: every item the excerpts name, each with the words that name it
 * (checked to be in the excerpts). Asked straight away, the model listed "indirect injection" as a combustion
 * chamber design and left out energy cells, though the section it read described them.
 */
async function itemsNamed(question, passages) {
  const text = passages.map((p) => stripFigureMarkers(p.content)).join('\n\n');
  const prompt =
    `A user asks: "${question}"\n\nExcerpts from their documents:\n${text}\n\n` +
    `List every item the excerpts name that answers the question: each thing of the kind asked for (each type, ` +
    `design, part, step, stage or method), in the excerpts' order. For each: name (a few words), quote (the ` +
    `excerpt's words that name or describe it, copied exactly, at most 30 words), and part_of (a broader term ` +
    `the excerpts put it under, or empty). A broader term that covers several items (a family or category) is ` +
    `not an item itself: give it as their part_of. Only items the excerpts name; none when they name none.`;
  const schema = {
    type: 'object',
    properties: {
      items: {
        type: 'array', maxItems: MAX_LIST_ITEMS,
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, quote: { type: 'string' }, part_of: { type: 'string' } },
          required: ['name', 'quote', 'part_of'],
        },
      },
    },
    required: ['items'],
  };
  try {
    const { items = [] } = await generateStructured(prompt, config.ollama.generateModel, schema, { think: false });
    return items.filter((it) => it.name?.trim() && quoteFound(it.quote, text))
      .map((it) => ({ name: it.name.trim(), partOf: String(it.part_of || '').trim() }));
  } catch (err) {
    console.warn(`Listing items skipped: ${err.message}`);
    return [];
  }
}

const words = (t) => String(t).toLowerCase().replace(/[^a-z0-9%]+/g, ' ').split(' ').filter((w) => w.length > 3);

/** The items an answer does not mention (by name, or by every longer word of the name). */
function itemsLeftOut(items, answer) {
  const said = ` ${String(answer).toLowerCase().replace(/[^a-z0-9%]+/g, ' ')} `;
  return items.filter((it) => {
    const name = it.name.toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
    if (said.includes(` ${name} `)) return false;
    const key = words(it.name);
    return !key.length || !key.every((w) => said.includes(w.replace(/s$/, '')));
  });
}

/** The documents a whole-document request is about: all when asked, otherwise the ones the search matched best. */
function documentsMeant(allDocuments, docIds, topChunks) {
  if (docIds.length <= 1 || allDocuments || !topChunks.length) return docIds;
  const bestByDoc = new Map();
  for (const c of topChunks) bestByDoc.set(c.document_id, Math.max(bestByDoc.get(c.document_id) ?? 0, c.similarity));
  const top = Math.max(...bestByDoc.values());
  return [...bestByDoc].filter(([, s]) => s >= top - 0.05).map(([id]) => id);
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
  const { query: searchQuery, scope, smallTalk, aboutDocuments, allDocuments, wantsList } = await understandMessage(
    history, question, { canChangeLast: again.length > 0, documents },
  );
  if (scope === 'change_last_answer' && again.length) return answerWholeDocument(question, history, again, onPhase, { change: true });

  if (smallTalk && scope === 'specific') return answerFromGeneralKnowledge(question, history, true, onPhase);

  onPhase('searching');
  const { passages: finalChunks, best } = await findSections(searchQuery, docIds, { k: config.rag.topK, maxChars: ANSWER_CHARS });
  // A whole-document request skips the relevance gate: "give me the gist" matches no passage closely.
  if (scope === 'whole_document') return answerWholeDocument(question, history, documentsMeant(allDocuments, docIds, finalChunks), onPhase);
  if (best < NOTHING_CLOSE || (!aboutDocuments && best < UNRELATED_MAX)) {
    return answerFromGeneralKnowledge(question, history, false, onPhase);
  }

  onPhase('generating');
  const available = await figuresInChunks(finalChunks);
  const excerpts = finalChunks.map((c) => ({ ...c, content: stripFigureMarkers(c.content) }));
  // A question asking for a set of things: the set first, then an answer covering all of it.
  const mustCover = wantsList ? await itemsNamed(question, finalChunks) : [];
  // The rewrite is only for retrieval. Answer what the user actually asked; history supplies the context.
  let { llmResponse, grounded } = await generateAnswer(question, history, excerpts, available, { mustCover });
  const missing = itemsLeftOut(mustCover, llmResponse.content);
  if (grounded && missing.length) {
    ({ llmResponse, grounded } = await generateAnswer(question, history, excerpts, available, { mustCover, missing }));
  }
  // Figures shown under the answer: only those it refers to.
  const figures = figuresMentioned(available, llmResponse.content).map((f) => ({
    id: f.id, caption: f.caption, page: f.page, width: f.width, height: f.height, document_id: f.document_id,
    description: f.description, description_edited: f.description_edited,
  }));
  const sourceIds = finalChunks.slice(0, SOURCES_KEPT).map((c) => c.id);
  const content = grounded ? llmResponse.content : withoutRepeatedNote(llmResponse.content, history);
  return { content, grounded, figures, sourceIds };
}

async function answerWholeDocument(question, history, docIds, onPhase, { change = false } = {}) {
  onPhase('covering');
  // A change ("shorter", "in Malay") applies to the request that produced the last answer.
  const asked = change ? history.findLast((m) => m.role === 'user')?.content : null;
  const request = asked ? `${asked}\nThen they asked for this change: ${question}` : question;
  const { content, sourceIds } = await coverDocuments(docIds, request);
  return { content, grounded: true, figures: [], sourceIds, wholeDocument: docIds };
}

async function answerFromGeneralKnowledge(question, history, smallTalk, onPhase) {
  onPhase('generating');
  const reply = await generateGeneralAnswer(question, history, { smallTalk });
  return { content: withoutRepeatedNote(reply.content, history), grounded: false, smallTalk, figures: [], sourceIds: [] };
}
