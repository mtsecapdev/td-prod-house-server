import config from '../../config.js';

const { baseUrl, numCtx } = config.ollama;

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

export async function generate(prompt, model, { format, think } = {}) {
  // Same num_ctx on every call: Ollama reloads the model whenever it changes.
  const body = { model, prompt, stream: false, options: { num_ctx: numCtx } };
  if (format) body.format = format;
  if (think !== undefined) body.think = think;
  const data = await ollamaFetch('/api/generate', body);
  return data.response;
}

export async function chat(messages, model, { format, think } = {}) {
  const body = { model, messages, stream: false, options: { num_ctx: numCtx } };
  if (format) body.format = format;
  if (think !== undefined) body.think = think;
  const data = await ollamaFetch('/api/chat', body);
  return data.message;
}

export async function unload(model) {
  await ollamaFetch('/api/generate', { model, keep_alive: 0 });
}
