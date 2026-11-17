// Re-embed every chunk with the current EMBEDDING_MODEL_NAME, in place.
// Run after changing the embedding model: vectors from different models are not comparable,
// so search breaks until every chunk is re-embedded. Chunk text, pages, headings and summaries
// are kept; only the embedding column changes. All-or-nothing (single transaction).
import pool from '../db/pool.js';
import pgvector from 'pgvector/pg';
import config from '../config.js';
import { requestEmbeddingBatch } from '../services/llm.js';
import { enrichTextForEmbedding } from '../services/textChunker.js';

const BATCH = 50;

const client = await pool.connect();
try {
  const { rows } = await client.query('SELECT id, content, page, heading FROM chunks ORDER BY id');
  console.log(`Re-embedding ${rows.length} chunks with ${config.ollama.embeddingModel}...`);

  await client.query('BEGIN');

  // A different model may output a different vector size; resize the column to match.
  // The ANN index depends on the column type, so drop it and rebuild it afterwards.
  const dim = config.ollama.embeddingDim;
  const { rows: [col] } = await client.query(
    `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
     WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'`,
  );
  const resize = col.type !== `vector(${dim})`;
  if (resize) {
    console.log(`Resizing chunks.embedding: ${col.type} -> vector(${dim})`);
    await client.query('DROP INDEX IF EXISTS chunks_embedding_idx');
    await client.query(`ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(${dim}) USING NULL`);
  }

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    // Same input text as at ingestion time (documentsController, ingest.js, summarizer.js).
    const texts = batch.map((r) => enrichTextForEmbedding(r.content, { page: r.page, heading: r.heading }));
    const embeddings = await requestEmbeddingBatch(texts);
    for (let j = 0; j < batch.length; j++) {
      await client.query('UPDATE chunks SET embedding = $1 WHERE id = $2', [
        pgvector.toSql(embeddings[j]),
        batch[j].id,
      ]);
    }
    console.log(`  ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }
  if (resize) {
    // Same definition as createSchemas.js.
    await client.query(
      'CREATE INDEX chunks_embedding_idx ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)',
    );
  }
  await client.query('COMMIT');
  console.log('Done.');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Re-embedding failed, no changes saved:', err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
