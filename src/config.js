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
};

export default config;
