import AppError from '../utils/AppError.js';

/**
 * Takes in a chunk as a string, makes a call to ollama embedding endpoint, returns the number[] containing the embeddings of that chunk.
 * @param {string} input
 * @returns number[] that contains the required embeddings.
 */
export async function requestEmbedding(input) {
  try {
    const res = await fetch(new URL('/api/embed', process.env.OLLAMA_BASE_URL), {
      method: 'POST',
      body: JSON.stringify({
        model: process.env.EMBEDDING_MODEL_NAME,
        input,
      }),
    });

    // Need a res.ok check cos with fetch, status codes like 404 or 500 dont throw errors,
    // as the promise is still considered resolved.
    if (!res.ok) {
      throw new Error(
        `Embedding request failed. Response original text: ${res.statusText}`,
      );
    }

    const data = await res.json();
    return data.embeddings[0];
  } catch (error) {
    throw new AppError(
      `llm service error: ${error.message}`,
      error.statusCode ?? 503,
      error,
    );
  }
}

/**
 *
 * @param {string} query
 * @param {object[]} history 
 * @param {chunks[]} kChunks
 * @returns {string} Model's response to the query and the chunks provided.
 *
 * @type {Response}
 */
export async function generateAnswer(query, history, kChunks) {
  // Create the prompt
  let listOfChunks = '';
  let totalConfidenceScore = 0;

  // Calculate the avg confidence score of the k chunks; this then informs the LLM whether the score is above the score threshold (0.6 - can be changed in the SYSTEM_PROMPT) so it can choose to give a "no confidence" answer or not.
  kChunks.forEach((chunk, index) => {
    listOfChunks += `Chunk ${index + 1}, Similarity Score ${chunk.similarity}: ${chunk.content}\n`;
    totalConfidenceScore += chunk.similarity;
  });
  const avgConfidenceScore = totalConfidenceScore / kChunks.length;

  const systemMessage =
    process.env.SYSTEM_PROMPT +
    `Document excerpts (average confidence score: ${avgConfidenceScore})\n` +
    listOfChunks;

  const newUserQuery = {role: 'user', content: query};

  try {
    const res = await fetch(new URL('/api/chat', process.env.OLLAMA_BASE_URL), {
      method: 'POST',
      body: JSON.stringify({
        model: process.env.GENERATE_MODEL_NAME,
        messages: [
          {role: 'system', content: systemMessage},
          ...history,
          newUserQuery
        ],
        stream: false,
      }),
    });

    // Need a res.ok check cos with fetch, status codes like 404 or 500 dont throw errors,
    // as the promise is still considered resolved.
    if (!res.ok) {
      throw new Error(
        `Generate request failed. Response original text: ${res.statusText}`,
      );
    }

    const data = await res.json();
    return [newUserQuery, data.message]
  } catch (error) {
    throw new AppError(
      `llm service error: ${error.message}`,
      error.statusCode ?? 503,
      error,
    );
  }
}
