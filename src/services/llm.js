import AppError from '../utils/AppError.js';
import config from '../config.js';

const { baseUrl, embeddingModel, rewriteModel, generateModel } = config.ollama;

async function ollamaFetch(path, body) {
  const res = await fetch(new URL(path, baseUrl), {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Ollama ${path} failed: ${res.statusText}`);
  }

  return res.json();
}

/**
 * @param {string} input
 * @returns {Promise<number[]>}
 */
export async function requestEmbedding(input) {
  try {
    const data = await ollamaFetch('/api/embed', {
      model: embeddingModel,
      input,
    });
    return data.embeddings[0];
  } catch (error) {
    throw new AppError(`Embedding failed: ${error.message}`, 503, error);
  }
}

const NUM_RECENT_MESSAGES = 6;

/**
 * Rewrites a query to be self-contained using recent conversation history.
 * Returns the original query unchanged if there is no history.
 * @param {object[]} history
 * @param {string} originalQuery
 * @returns {Promise<string>}
 */
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
    const data = await ollamaFetch('/api/generate', {
      model: rewriteModel,
      prompt,
      stream: false,
    });
    return data.response;
  } catch (error) {
    throw new AppError(`Query rewrite failed: ${error.message}`, 503, error);
  }
}

const CONFIDENCE_THRESHOLD = 0.6;

/**
 * Generates an answer grounded in the provided chunks.
 * @param {string} query
 * @param {object[]} history
 * @param {object[]} chunks
 * @returns {Promise<{llmResponse: object, avgConfidenceScore: number}>}
 */
export async function generateAnswer(query, history, chunks) {
  let listOfChunks = '';
  let totalScore = 0;

  chunks.forEach((chunk, i) => {
    listOfChunks += `Chunk ${i + 1}, Similarity ${chunk.similarity}: ${chunk.content}\n`;
    totalScore += chunk.similarity;
  });

  const avgConfidenceScore = chunks.length > 0 ? totalScore / chunks.length : 0;

  const systemPrompt =
    `You are a helpful assistant that answers questions based on provided document excerpts.\n` +
    `You are in a multi-turn conversation. You may reference previous exchanges where relevant.\n\n` +
    `Rules:\n` +
    `- Answer only from the provided excerpts. Do not use outside knowledge.\n` +
    `- If the average confidence score is below ${CONFIDENCE_THRESHOLD}, insert this line BEFORE your answer: ` +
    `'Could not find highly relevant content. The documents may not cover this topic, or try rephrasing your query.'\n` +
    `- Do not display the confidence score in the response.\n` +
    `- Do not infer or combine information across excerpts beyond what is explicitly stated.\n` +
    `- If unsure, use 'should' or 'may' rather than definitive statements.\n` +
    `- Be concise.\n\n` +
    `Document excerpts (average confidence score: ${avgConfidenceScore}):\n` +
    listOfChunks;

  try {
    const data = await ollamaFetch('/api/chat', {
      model: generateModel,
      messages: [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: query },
      ],
      stream: false,
    });
    return { llmResponse: data.message, avgConfidenceScore };
  } catch (error) {
    throw new AppError(`Answer generation failed: ${error.message}`, 503, error);
  }
}
