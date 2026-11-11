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
  },
  docling: {
    endpoint: required('DOCLING_SERVE_ENDPOINT'),
  },
  rag: {
    topK: Number(process.env.K_CHUNKS ?? 5),
  },
  sourcesDir: process.env.SOURCES_DIR || 'D:\\tdph\\sources',
  uploadsDir: process.env.UPLOADS_DIR || 'D:\\tdph\\uploads',
  outputDir: process.env.OUTPUT_DIR || 'D:\\tdph\\data\\assets',
  comfyui: {
    baseUrl: process.env.COMFYUI_BASE_URL || 'http://127.0.0.1:8188',
    dir: process.env.COMFYUI_DIR || 'D:\\tdph\\ComfyUI\\ComfyUI_windows_portable',
  },
  deckCraftPath: process.env.DECKCRAFT_PATH || 'D:\\tdph\\deckcraft\\deckcraft-0.15.1-windows-x64-portable\\deckcraft.exe',
  wordCraftPath: process.env.WORDCRAFT_PATH || 'D:\\tdph\\wordcraft\\wordcraft-0.15.2-windows-x64-portable\\wordcraft.exe',
};

export default config;
