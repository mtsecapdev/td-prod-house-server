import config from '../../config.js';

const { baseUrl, numCtx, numPredict, requestTimeoutMs } = config.ollama;

// Same num_ctx on every call: Ollama reloads the model whenever it changes. num_predict caps output (thinking
// included) so a model stuck in a reasoning loop ends instead of holding the GPU until the request times out.
const OPTIONS = { num_ctx: numCtx, num_predict: numPredict };

async function ollamaFetch(path, body, timeoutMs = 600_000) {
  const res = await fetch(new URL(path, baseUrl), {
    method: 'POST',
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Ollama ${path} failed: ${res.statusText}`);
  return res.json();
}

export async function embed(input, model) {
  const data = await ollamaFetch('/api/embed', { model, input });
  return data.embeddings[0];
}

export async function embedBatch(inputs, model) {
  const data = await ollamaFetch('/api/embed', { model, input: inputs });
  return data.embeddings;
}

/**
 * Streams a generate/chat call and returns the joined text. Streaming matters for long calls: with
 * stream:false Ollama sends nothing until it finishes, and Node's fetch gives up after 5 minutes without
 * response headers, whatever timeout we set.
 * @returns {Promise<{ text: string, truncated: boolean }>}
 */
async function ollamaStream(path, body) {
  const res = await fetch(new URL(path, baseUrl), {
    method: 'POST',
    body: JSON.stringify({ ...body, stream: true }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!res.ok) throw new Error(`Ollama ${path} failed: ${res.status} ${await res.text()}`);

  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let truncated = false;
  const take = (line) => {
    if (!line.trim()) return;
    const data = JSON.parse(line);
    if (data.error) throw new Error(`Ollama ${path} failed: ${data.error}`);
    text += path === '/api/chat' ? (data.message?.content || '') : (data.response || '');
    if (data.done && data.done_reason === 'length') truncated = true;
  };
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      take(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  take(buffer);
  return { text, truncated };
}

export class OutputTruncatedError extends Error {}

// numCtx: a model's own context window instead of the shared one (the vision model's is small, so it fits beside
// the text model). Keep it the same on every call to that model: Ollama reloads a model whose num_ctx changes.
// Its output (reasoning included) may use three quarters of it: an image and a short prompt take ~1.5k tokens,
// and the vision model reasoned ~3.8k tokens over a figure with three drawings.
function bodyFor(extra, { format, think, numCtx }) {
  const options = numCtx ? { num_ctx: numCtx, num_predict: Math.min(numPredict, Math.floor(numCtx * 0.75)) } : OPTIONS;
  const body = { ...extra, options };
  if (format) body.format = format;
  if (think !== undefined) body.think = think;
  return body;
}

export async function generate(prompt, model, opts = {}) {
  const { text, truncated } = await ollamaStream('/api/generate', bodyFor({ model, prompt }, opts));
  if (truncated && opts.format) throw new OutputTruncatedError(`Output hit the ${numPredict}-token limit`);
  return text;
}

export async function chat(messages, model, opts = {}) {
  const { text, truncated } = await ollamaStream('/api/chat', bodyFor({ model, messages }, opts));
  if (truncated && opts.format) throw new OutputTruncatedError(`Output hit the ${numPredict}-token limit`);
  return { role: 'assistant', content: text };
}

export async function unload(model) {
  await ollamaFetch('/api/generate', { model, keep_alive: 0 });
}
