import AppError from '../utils/AppError.js';

/**
 * Takes in a chunk as a string, makes a call to ollama embedding endpoint, returns the number[] containing the embeddings of that chunk.
 * @param {string} input
 * @returns {number[]} that contains the required embeddings.
 */
export async function requestEmbedding(input) {
  try {
    const res = await fetch(
      new URL('/api/embed', process.env.OLLAMA_BASE_URL),
      {
        method: 'POST',
        body: JSON.stringify({
          model: process.env.EMBEDDING_MODEL_NAME,
          input,
        }),
      },
    );

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
 * Rewrites the query based on the past contextual history.
 * @param {object[]} history
 * @param {string} originalQuery
 * @returns {string} rewrittenQuery
 */
export async function rewriteQuery(history, originalQuery) {
  if (!history || history.length === 0) return originalQuery;

  const NUM_MOST_RECENT_MESSAGES = 6;
  // history should look like this with the final 6 ones being the last 3 pairs of user-assistant responses.
  // { role: 'user', content: ... }
  // { role: 'assistant', content: ... }
  // Extract out these last up to 6 objects.
  const recentHistory = history.slice(-NUM_MOST_RECENT_MESSAGES);
  // Use map array to create an array of 'User/Assistant: content', then join them into one string with \n
  const recentHistoryString = recentHistory
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');
  // Then, feed this history to the rewrite llm at the api/generate endpoint with the correct sys prompt
  const prompt =
    `Given this conversation history:\n${recentHistoryString}\n\n` +
    `Rewrite the following query to be fully self-contained and specific, ` +
    `suitable for a semantic document search. ` +
    `Return only the rewritten query, no explanation.\n\n` +
    `Query: ${originalQuery}`;

  try {
    const res = await fetch(
      new URL('/api/generate', process.env.OLLAMA_BASE_URL),
      {
        method: 'POST',
        body: JSON.stringify({
          model: process.env.REWRITE_QUERY_MODEL_NAME,
          prompt,
          stream: false,
        }),
      },
    );

    // Need a res.ok check cos with fetch, status codes like 404 or 500 dont throw errors,
    // as the promise is still considered resolved.
    if (!res.ok) {
      throw new Error(
        `Rewrite query request failed. Response original text: ${res.statusText}`,
      );
    }

    const data = await res.json();
    return data.response;
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
 * @returns {object} {role: 'assistant', content: the generated message}
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

  const newUserQuery = { role: 'user', content: query };

  try {
    const res = await fetch(new URL('/api/chat', process.env.OLLAMA_BASE_URL), {
      method: 'POST',
      body: JSON.stringify({
        model: process.env.GENERATE_MODEL_NAME,
        messages: [
          { role: 'system', content: systemMessage },
          ...history,
          newUserQuery,
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
    return data.message;
  } catch (error) {
    throw new AppError(
      `llm service error: ${error.message}`,
      error.statusCode ?? 503,
      error,
    );
  }
}
