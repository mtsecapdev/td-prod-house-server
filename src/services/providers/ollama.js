import config from '../../config.js';

const { baseUrl } = config.ollama;

async function ollamaFetch(path, body) {
  const res = await fetch(new URL(path, baseUrl), {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Ollama ${path} failed: ${res.statusText}`);
  return res.json();
}

export async function embed(input, model) {
  const data = await ollamaFetch('/api/embed', { model, input });
  return data.embeddings[0];
}

export async function generate(prompt, model, { format } = {}) {
  const body = { model, prompt, stream: false };
  if (format) body.format = format;
  const data = await ollamaFetch('/api/generate', body);
  return data.response;
}

export async function chat(messages, model, { format } = {}) {
  const body = { model, messages, stream: false };
  if (format) body.format = format;
  const data = await ollamaFetch('/api/chat', body);
  return data.message;
}

export async function unload(model) {
  await ollamaFetch('/api/generate', { model, keep_alive: 0 });
}
