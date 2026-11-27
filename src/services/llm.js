import AppError from '../utils/AppError.js';
import config from '../config.js';
import * as provider from './providers/ollama.js';

const { embeddingModel, rewriteModel, generateModel } = config.ollama;

export async function requestEmbedding(input) {
  try {
    return await provider.embed(input, embeddingModel);
  } catch (error) {
    throw new AppError(`Embedding failed: ${error.message}`, 503, error);
  }
}

const EMBED_BATCH_SIZE = 20;

export async function requestEmbeddingBatch(inputs) {
  try {
    const results = [];
    for (let i = 0; i < inputs.length; i += EMBED_BATCH_SIZE) {
      const batch = inputs.slice(i, i + EMBED_BATCH_SIZE);
      const embeddings = await provider.embedBatch(batch, embeddingModel);
      results.push(...embeddings);
    }
    return results;
  } catch (error) {
    throw new AppError(`Batch embedding failed: ${error.message}`, 503, error);
  }
}

const NUM_RECENT_MESSAGES = 4;
// Earlier turns are shown shortened: a whole-report summary would otherwise fill the prompt.
const RECENT_MESSAGE_CHARS = 700;

/**
 * Reads a chat message once, before searching: the search query it needs (self-contained, using the
 * conversation), whether it wants a whole document covered, whether it only asks to redo the previous answer, and
 * whether it means every selected document. One short structured call (~0.5 s). The conversation goes in as real
 * turns, so a reply like "more detail please" reads as a reply to the last answer; each choice is its own yes/no
 * question, which this small model judges better than one choice among three.
 * @returns {Promise<{ query: string, scope: 'specific'|'whole_document'|'change_last_answer', smallTalk: boolean, aboutDocuments: boolean,
 *   allDocuments: boolean }>}
 */
export async function understandMessage(history, message, { canChangeLast = false, documents = [] } = {}) {
  const recent = (history || []).slice(-NUM_RECENT_MESSAGES).map((m) => ({
    role: m.role,
    content: m.content.length > RECENT_MESSAGE_CHARS ? `${m.content.slice(0, RECENT_MESSAGE_CHARS)}...` : m.content,
  }));
  const system =
    `You read the user's next message in a workspace where they chat about their uploaded documents. Do not ` +
    `answer it.\n` +
    (documents.length
      ? `Their documents:\n${documents.map((d) => `- ${d.name}${d.overview ? `: ${d.overview.replace(/\s+/g, ' ')}...` : ''}`).join('\n')}\n`
      : '') +
    `Return JSON:\n` +
    (canChangeLast
      ? `- redo_previous_answer: true when the message only tells you how to redo your previous answer, with no ` +
        `new question: add references, sources, citations or page numbers; make it shorter, longer or more ` +
        `detailed; use bullets, a table or another language; or be sure it includes something. False when it asks ` +
        `something new (a fact, a topic, "why", "who", "what about X").\n`
      : '') +
    `- whole_document: true when the user wants a whole document taken in: its summary, gist, overview or main ` +
    `points, what it is about or covers, or a briefing on it; also true when they want each or all of their ` +
    `documents summarised. False when they ask about particular facts or topics: a summary or overview OF ONE ` +
    `topic, policy, site, section or part (e.g. "overview of the hiring policy", "summary of chapter 3") is ` +
    `false.\n` +
    `- small_talk: true for greetings, thanks, goodbyes and chit-chat, even in the middle of a conversation.\n` +
    `- about_documents: true when the message could be answered from their documents or asks about something ` +
    `in them or in this conversation (names, roles, figures, terms, sites, topics), even if it is short or uses ` +
    `an abbreviation. False for small talk and for questions plainly unrelated to the documents (a recipe, ` +
    `sport, coding help).\n` +
    `- all_documents: true when they want all of their documents covered, or ask what documents they have. ` +
    `False when it is about one document.\n` +
    `- wants_list: true when they ask for a set of things the documents name: all the types, kinds, designs, ` +
    `parts, steps, stages, methods or examples of something ("what are the types of...", "list the...", "which ` +
    `... are there", "what are the steps..."). False for one fact, an explanation or a comparison of two named ` +
    `things.\n` +
    `- query: their message rewritten as a self-contained search query for the documents. Resolve "this", "it" ` +
    `or "that document" from the conversation, name the company or document the conversation is about, spell ` +
    `out abbreviations alongside them ("CFO (Chief Financial Officer)"), and keep everything asked for (a page, ` +
    `date or source).\n` +
    `Messages can be in any language.`;
  const properties = {
    ...(canChangeLast ? { redo_previous_answer: { type: 'boolean' } } : {}),
    whole_document: { type: 'boolean' },
    small_talk: { type: 'boolean' },
    about_documents: { type: 'boolean' },
    all_documents: { type: 'boolean' },
    wants_list: { type: 'boolean' },
    query: { type: 'string' },
  };
  const format = { type: 'object', properties, required: Object.keys(properties) };
  try {
    // With think:false qwen3 still reasons in plain text unless a JSON schema forces a short answer.
    const reply = await provider.chat(
      [{ role: 'system', content: system }, ...recent, { role: 'user', content: message }],
      rewriteModel, { think: false, format },
    );
    let parsed = {};
    try { parsed = JSON.parse(reply.content); } catch { /* fall back below */ }
    const scope = canChangeLast && parsed.redo_previous_answer === true ? 'change_last_answer'
      : parsed.whole_document === true ? 'whole_document' : 'specific';
    return {
      // Without history there is nothing to resolve: search with the user's own words.
      query: (history?.length && String(parsed.query ?? '').trim()) || message,
      scope,
      smallTalk: parsed.small_talk === true,
      aboutDocuments: parsed.small_talk !== true && parsed.about_documents !== false,
      allDocuments: parsed.all_documents === true,
      wantsList: parsed.wants_list === true,
    };
  } catch (error) {
    throw new AppError(`Reading the message failed: ${error.message}`, 503, error);
  }
}

const NOT_IN_DOCS_MARKER = '[NOT IN DOCUMENTS]';
const NOT_IN_DOCS_RE = /\[\s*NOT[ _]IN[ _]DOCUMENTS\s*\]/gi;

/**
 * Answers a question the user's documents don't cover (nothing in them came close), from general knowledge,
 * without reading any excerpts.
 */
export async function generateGeneralAnswer(query, history, { smallTalk = false } = {}) {
  const systemPrompt = smallTalk
    ? `You are a friendly assistant in a workspace where users chat about their documents. Reply naturally and ` +
      `briefly, in a sentence or two, in plain text.`
    : `You are a knowledgeable assistant in a workspace where users chat about their documents. This question is ` +
      `not covered by the documents they selected. Start with one short sentence telling them, in the second ` +
      `person ("Your documents don't cover this, but..."), then answer it helpfully (when this conversation has ` +
      `already established that the documents don't cover the topic, skip that sentence and just reply) ` +
      `from general knowledge, concisely. Use plain text only: no markdown (no **, *, # or - bullets). For a ` +
      `list, write numbered lines (1. 2. 3.).`;
  try {
    return await provider.chat([{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: query }], generateModel);
  } catch (error) {
    throw new AppError(`Answer generation failed: ${error.message}`, 503, error);
  }
}

/**
 * Answers from document excerpts. mustCover: the items the excerpts name for a list question ([{ name, partOf }]),
 * each of which the answer covers; missing: items an earlier attempt left out.
 */
export async function generateAnswer(query, history, chunks, figures = [], { mustCover = [], missing = [] } = {}) {
  let listOfChunks = '';
  let totalScore = 0;

  // Label excerpts by where they come from (page, section), not by position: positions change every
  // turn and mean nothing to the user, so the model would otherwise cite "Chunk 2".
  // Excerpts are passed in full. textChunker already caps them (~2000 chars); cutting them here
  // silently hid the second half of most chunks, including the rows of long tables.
  chunks.forEach((chunk) => {
    const levelTag = chunk.level === 'document' ? 'document summary' : chunk.level === 'section' ? 'section summary' : null;
    const meta = [chunk.page != null ? `p. ${chunk.page}` : null, chunk.heading, levelTag]
      .filter(Boolean).join(' · ');
    listOfChunks += `[${meta || 'excerpt'}]\n${chunk.content}\n\n`;
    totalScore += chunk.similarity;
  });

  const avgConfidenceScore = chunks.length > 0 ? totalScore / chunks.length : 0;

  const systemPrompt =
    `You are a knowledgeable assistant helping users understand and discuss documents.\n` +
    `You are in a multi-turn conversation. You may reference previous exchanges where relevant.\n` +
    `Your earlier replies may have been based on fewer or different excerpts (documents get re-uploaded and ` +
    `searches differ). When the excerpts below contain the answer, use them, even if an earlier reply said ` +
    `the documents did not cover it; say briefly that you now have more detail.\n\n` +
    `How to answer:\n` +
    `- For factual questions about the documents, answer from the provided excerpts.\n` +
    `- When the user asks "what do you think", asks for your opinion, or wants analysis/comparison/context beyond what the documents cover — give your own informed answer using your general knowledge. If the documents say something relevant, note it briefly first.\n` +
    `- When the excerpts don't cover the question, say so in at most one short sentence ("Your documents don't ` +
    `cover this, but...") and then answer. Never describe what the excerpts are about instead, and cite no pages ` +
    `for it. If this conversation has already established that the documents don't cover the topic, skip that ` +
    `sentence entirely and just answer.\n` +
    `- Do not refuse to answer or say "the document doesn't cover this" when the user is clearly asking for YOUR thoughts. They want a discussion, not a search engine.\n` +
    `- When the user asks to be taught something or to explain a topic, give a thorough answer using all relevant excerpts. Do not hold back content.\n` +
    `- For direct questions, be concise but substantive.\n` +
    `- Each excerpt is labelled with its page and section, e.g. [p. 4 · 2.4 Group at a glance]. ` +
    `When you state a fact from the documents, cite only its page number in parentheses, e.g. (p. 4). ` +
    `When the user asks where something is stated, list the pages and section names. ` +
    `An excerpt can run onto a later page: a line like [p. 22] inside it means the text after it is on page 22, ` +
    `so cite that page for it. ` +
    `Never mention excerpts, chunks or their labels; the user cannot see them.\n` +
    `- Use plain text only: no markdown (no **, *, # or - bullets). For a list, write numbered lines (1. 2. 3.).\n` +
    (figures.length
      ? `- Figures in these excerpts. You cannot see them, only their caption and the text printed in them, ` +
        `listed in reading order (so labels that belong together are usually next to each other). When asked about ` +
        `a figure, describe what its text shows: the groups and the items in each. The user can see the figure ` +
        `and you cannot: when they say what kind of figure it is (a Venn diagram, a flowchart...), take that as ` +
        `correct and use it (in a Venn diagram, the labels between two groups are the overlap). Never say a figure ` +
        `is not what the user calls it. Name the figure by its caption, e.g. "Figure 2.0-1"; the user will see the ` +
        `figure itself under your answer.\n` +
        figures.map((f) => `  * ${f.caption || 'Untitled figure'} (p. ${f.page ?? '?'})` +
          (f.labels ? `. Text in it: ${f.labels}` : '')).join('\n') + '\n'
      : '') +
    (mustCover.length
      ? `- This question asks for a set of things. The excerpts name exactly these (in their order); cover every ` +
        `one, as items of their own, and present a broader term as the group they belong to, not as one of ` +
        `them:\n` + mustCover.map((it) => `  * ${it.name}${it.partOf ? ` (a kind of ${it.partOf})` : ''}`).join('\n') + '\n' +
        (missing.length ? `  A previous answer left out: ${missing.map((it) => it.name).join(', ')}. Include them.\n` : '')
      : '') +
    `- Last step, always: decide whether the excerpts contain the answer. If they do not (the question is about ` +
    `something the documents don't mention, or is unrelated to them, such as general trivia, and you answer from ` +
    `general knowledge or say it isn't covered), end your reply with ${NOT_IN_DOCS_MARKER} on its own line. ` +
    `Do not add it when the excerpts answer the question.\n\n` +
    `Document excerpts:\n` +
    listOfChunks;

  try {
    const llmResponse = await provider.chat(
      [{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: query }],
      generateModel,
    );
    // The model flags answers the excerpts don't support. Retrieval scores can't: unanswerable questions about
    // the document's subject ("staff in Brazil?") score as high as answerable ones.
    const grounded = !NOT_IN_DOCS_RE.test(llmResponse.content);
    llmResponse.content = llmResponse.content.replace(NOT_IN_DOCS_RE, '')
      // The model sometimes copies an excerpt's label: "(p. 4 · 2.1 History)" becomes "(p. 4)", "[p. 22]" "(p. 22)".
      .replace(/\((p\.\s*\d+(?:\s*[-–]\s*\d+)?)\s*·[^)]*\)/g, '($1)')
      .replace(/\[(p\.\s*\d+)\]/g, '($1)')
      .trimEnd();
    return { llmResponse, avgConfidenceScore, grounded };
  } catch (error) {
    throw new AppError(`Answer generation failed: ${error.message}`, 503, error);
  }
}

// Structured calls retry once without thinking when the first attempt runs out of tokens or returns
// unparseable JSON: reasoning loops are the usual cause, and the answer without them is still good.
// onRetry() lets a caller record that it happened.
async function structuredWithRetry(call, think, onRetry) {
  try {
    return JSON.parse(await call(think));
  } catch (first) {
    const retryable = first instanceof SyntaxError || first instanceof provider.OutputTruncatedError;
    if (!retryable || think === false) throw first;
    console.warn(`Structured output failed (${first.message}); retrying without thinking`);
    onRetry?.();
    return JSON.parse(await call(false));
  }
}

export async function generateStructured(prompt, model, format, { think, onRetry } = {}) {
  try {
    return await structuredWithRetry((t) => provider.generate(prompt, model, { format, think: t }), think, onRetry);
  } catch (error) {
    throw new AppError(`Structured generation failed: ${error.message}`, 503, error);
  }
}

export async function chatStructured(messages, model, format, { think = false } = {}) {
  try {
    return await structuredWithRetry(
      async (t) => (await provider.chat(messages, model, { format, think: t })).content,
      think,
    );
  } catch (error) {
    throw new AppError(`Structured chat failed: ${error.message}`, 503, error);
  }
}
