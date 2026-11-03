import pool from './pool.js';
import pgvector from 'pgvector/pg';

async function createTables() {
  const client = await pool.connect();
  await pgvector.registerTypes(client);

  try {
    await client.query('BEGIN');
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');

    await client.query(`CREATE TABLE IF NOT EXISTS documents (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL,
      file_path TEXT,
      file_hash TEXT,
      page_count INTEGER,
      status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'failed')),
      error TEXT,
      uploaded_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      embedding VECTOR(768),
      page INTEGER,
      heading TEXT
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS generations (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('deck', 'doc', 'image', 'infographic')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'generating', 'outline_ready', 'done', 'failed')),
      brief JSONB,
      outline JSONB,
      source_document_ids INTEGER[],
      model TEXT,
      settings JSONB,
      edit_history JSONB[] DEFAULT '{}',
      error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS assets (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      file_path TEXT NOT NULL,
      mime TEXT,
      title TEXT,
      saved_at TIMESTAMPTZ DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
    )`);

    await client.query('COMMIT');
    console.log('Tables created successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Table creation failed, rolled back:', error.message);
  } finally {
    client.release();
    await pool.end();
  }
}

await createTables();
