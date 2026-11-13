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
    `Return only the rewritten query, no explanation.\n\n` +
    `Query: ${originalQuery}`;

  try {
    return await provider.generate(prompt, rewriteModel);
  } catch (error) {
    throw new AppError(`Query rewrite failed: ${error.message}`, 503, error);
  }
}

const CHUNK_MAX_CHARS = 1200;

export async function generateAnswer(query, history, chunks) {
  let listOfChunks = '';
  let totalScore = 0;

  chunks.forEach((chunk, i) => {
    const trimmed = chunk.content.length > CHUNK_MAX_CHARS
      ? chunk.content.slice(0, CHUNK_MAX_CHARS) + '...'
      : chunk.content;
    const levelTag = chunk.level === 'document' ? 'DOC SUMMARY' : chunk.level === 'section' ? 'SECTION SUMMARY' : null;
    const meta = [levelTag, chunk.heading, chunk.page != null ? `Page ${chunk.page}` : null]
      .filter(Boolean).join(' | ');
    listOfChunks += `Chunk ${i + 1}${meta ? ` [${meta}]` : ''}: ${trimmed}\n`;
    totalScore += chunk.similarity;
  });

  const avgConfidenceScore = chunks.length > 0 ? totalScore / chunks.length : 0;

  const systemPrompt =
    `You are a knowledgeable assistant helping users understand and discuss documents.\n` +
    `You are in a multi-turn conversation. You may reference previous exchanges where relevant.\n\n` +
    `How to answer:\n` +
    `- For factual questions about the documents, answer from the provided excerpts.\n` +
    `- When the user asks "what do you think", asks for your opinion, or wants analysis/comparison/context beyond what the documents cover — give your own informed answer using your general knowledge. Briefly note what the document says first, then share your own perspective.\n` +
    `- Do not refuse to answer or say "the document doesn't cover this" when the user is clearly asking for YOUR thoughts. They want a discussion, not a search engine.\n` +
    `- When the user asks to be taught something or to explain a topic, give a thorough answer using all relevant excerpts. Do not hold back content.\n` +
    `- For direct questions, be concise but substantive.\n` +
    `- Use plain text only. Do not use markdown formatting (no **, *, #, or bullet symbols like -).\n\n` +
    `Document excerpts:\n` +
    listOfChunks;

  try {
    const llmResponse = await provider.chat(
      [{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: query }],
      generateModel,
    );
    return { llmResponse, avgConfidenceScore };
  } catch (error) {
    throw new AppError(`Answer generation failed: ${error.message}`, 503, error);
  }
}

export async function generateStructured(prompt, model, format, { think } = {}) {
  try {
    const response = await provider.generate(prompt, model, { format, think });
    return JSON.parse(response);
  } catch (error) {
    throw new AppError(`Structured generation failed: ${error.message}`, 503, error);
  }
}

export async function chatStructured(messages, model, format, { think = false } = {}) {
  try {
    const response = await provider.chat(messages, model, { format, think });
    return JSON.parse(response.content);
  } catch (error) {
    throw new AppError(`Structured chat failed: ${error.message}`, 503, error);
  }
}
