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

const NUM_RECENT_MESSAGES = 6;

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
    return await provider.generate(prompt, rewriteModel, { think: true });
  } catch (error) {
    throw new AppError(`Query rewrite failed: ${error.message}`, 503, error);
  }
}

const CONFIDENCE_THRESHOLD = 0.6;

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
