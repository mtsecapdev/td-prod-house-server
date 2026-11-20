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
const REWRITE_FORMAT = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
};

export async function rewriteQuery(history, originalQuery) {
  if (!history || history.length === 0) return originalQuery;

  const recent = history
    .slice(-NUM_RECENT_MESSAGES)
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');

  const prompt =
    `Given this conversation history:\n${recent}\n\n` +
    `Rewrite the following query to be fully self-contained and specific, ` +
    `suitable for a semantic document search. ` +
    `Resolve references like "this" or "it" using the history, and keep everything the user is asking for ` +
    `(for example a page, date or source). Keep it phrased as a question if it is one. ` +
    `Return only the rewritten query, no explanation.\n\n` +
    `Query: ${originalQuery}`;

  try {
    // With think:false qwen3 still reasons in plain text (1000+ tokens, 20-50 s) and that ramble became the
    // search query. A JSON schema forces a single short answer (~0.5 s).
    const raw = await provider.generate(prompt, rewriteModel, { think: false, format: REWRITE_FORMAT });
    let rewritten = '';
    try {
      rewritten = String(JSON.parse(raw).query ?? '').trim();
    } catch {
      // fall back to the user's own words
    }
    return rewritten || originalQuery;
  } catch (error) {
    throw new AppError(`Query rewrite failed: ${error.message}`, 503, error);
  }
}

const NOT_IN_DOCS_MARKER = '[NOT IN DOCUMENTS]';
const NOT_IN_DOCS_RE = /\[\s*NOT[ _]IN[ _]DOCUMENTS\s*\]/gi;

/**
 * Answers a question the user's documents don't cover (nothing in them came close), from general knowledge,
 * without reading any excerpts.
 */
export async function generateGeneralAnswer(query, history) {
  const systemPrompt =
    `You are a knowledgeable assistant in a workspace where users chat about their documents. This question is ` +
    `not covered by the documents they selected. Start with one short sentence telling them, in the second person ` +
    `("Your documents don't cover this, but..."), then answer it helpfully ` +
    `from general knowledge, concisely. Use plain text only: no markdown (no **, *, # or - bullets). For a list, ` +
    `write numbered lines (1. 2. 3.).`;
  try {
    return await provider.chat([{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: query }], generateModel);
  } catch (error) {
    throw new AppError(`Answer generation failed: ${error.message}`, 503, error);
  }
}

export async function generateAnswer(query, history, chunks, figures = []) {
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
    `- When the user asks "what do you think", asks for your opinion, or wants analysis/comparison/context beyond what the documents cover — give your own informed answer using your general knowledge. Briefly note what the document says first, then share your own perspective.\n` +
    `- Do not refuse to answer or say "the document doesn't cover this" when the user is clearly asking for YOUR thoughts. They want a discussion, not a search engine.\n` +
    `- When the user asks to be taught something or to explain a topic, give a thorough answer using all relevant excerpts. Do not hold back content.\n` +
    `- For direct questions, be concise but substantive.\n` +
    `- Each excerpt is labelled with its page and section, e.g. [p. 4 · 2.4 Group at a glance]. ` +
    `When you state a fact from the documents, cite only its page number in parentheses, e.g. (p. 4). ` +
    `When the user asks where something is stated, list the pages and section names. ` +
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
    llmResponse.content = llmResponse.content.replace(NOT_IN_DOCS_RE, '').trimEnd();
    return { llmResponse, avgConfidenceScore, grounded };
  } catch (error) {
    throw new AppError(`Answer generation failed: ${error.message}`, 503, error);
  }
}

// Structured calls retry once without thinking when the first attempt runs out of tokens or returns
// unparseable JSON: reasoning loops are the usual cause, and the answer without them is still good.
async function structuredWithRetry(call, think) {
  try {
    return JSON.parse(await call(think));
  } catch (first) {
    const retryable = first instanceof SyntaxError || first instanceof provider.OutputTruncatedError;
    if (!retryable || think === false) throw first;
    console.warn(`Structured output failed (${first.message}); retrying without thinking`);
    return JSON.parse(await call(false));
  }
}

export async function generateStructured(prompt, model, format, { think } = {}) {
  try {
    return await structuredWithRetry((t) => provider.generate(prompt, model, { format, think: t }), think);
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
