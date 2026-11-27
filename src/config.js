const required = (name) => {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
};

const config = {
  port: Number(required('SERVER_PORT')),
  databaseUrl: required('DATABASE_URL'),
  ollama: {
    baseUrl: required('OLLAMA_BASE_URL'),
    embeddingModel: required('EMBEDDING_MODEL_NAME'),
    rewriteModel: required('REWRITE_QUERY_MODEL_NAME'),
    generateModel: required('GENERATE_MODEL_NAME'),
    // A model that can see images (Qwen3-VL), for describing figures after import. Unset: figures are not
    // described, and picking goes by caption and the text printed in them.
    visionModel: process.env.VISION_MODEL_NAME || null,
    // A figure description needs little context (one image, a short prompt, some reasoning); a small window
    // keeps the vision model small enough to stay loaded beside the text model (qwen3-vl:4b: 3.4 GB at 8k,
    // 5.4 GB at 32k).
    visionNumCtx: Number(process.env.VISION_NUM_CTX ?? 8192),
    numCtx: Number(process.env.OLLAMA_NUM_CTX ?? 32768),
    // Max tokens per call, thinking included. Stops runaway reasoning loops.
    numPredict: Number(process.env.OLLAMA_NUM_PREDICT ?? 8192),
    requestTimeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS ?? 600_000),
    // Must match the embedding model's output size (bge-m3: 1024, nomic-embed-text: 768).
    // After changing model/dim, run `npm run reembed`.
    embeddingDim: Number(process.env.EMBEDDING_DIM ?? 1024),
  },
  docling: {
    endpoint: required('DOCLING_SERVE_ENDPOINT'),
  },
  renderer: {
    // Diagram render service (docker compose: renderer). Mermaid in, PNG out.
    endpoint: process.env.RENDER_SERVICE_ENDPOINT || 'http://127.0.0.1:5002',
  },
  // Send the session cookie over https only. Set SECURE_COOKIES=true on a server behind TLS.
  secureCookies: process.env.SECURE_COOKIES === 'true',
  rag: {
    topK: Number(process.env.K_CHUNKS ?? 10),
  },
  sourcesDir: process.env.SOURCES_DIR || 'D:\\tdph\\sources',
  uploadsDir: process.env.UPLOADS_DIR || 'D:\\tdph\\uploads',
  outputDir: process.env.OUTPUT_DIR || 'D:\\tdph\\data\\assets',
  pythonPath: process.env.PYTHON_PATH || 'python',
  deckCraftPath: process.env.DECKCRAFT_PATH || 'D:\\tdph\\deckcraft\\deckcraft-0.15.1-windows-x64-portable\\deckcraft.exe',
  wordCraftPath: process.env.WORDCRAFT_PATH || 'D:\\tdph\\wordcraft\\wordcraft-0.15.2-windows-x64-portable\\wordcraft.exe',
};

export default config;
