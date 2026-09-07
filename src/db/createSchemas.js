// Run this independently to create the tables/schemas in the db if setting up a new db.

// Import PG libraries
import pool from './pool.js';
import pgvector from 'pgvector/pg';

// Create "documents" table
async function createTables() {
  const client = await pool.connect();
  await pgvector.registerTypes(client);

  try {
    await client.query('BEGIN');

    // documents table
    await client.query(`CREATE TABLE IF NOT EXISTS documents (
      id INTEGER GENERATED ALWAYS AS IDENTITY,
      name TEXT NOT NULL,
      uploaded_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (id)
      );`);
    
    // chunks table
    await client.query(`CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER GENERATED ALWAYS AS IDENTITY,
      document_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding VECTOR(768),
      PRIMARY KEY (id),
      CONSTRAINT fk_document
        FOREIGN KEY (document_id)
        REFERENCES documents(id)
        ON DELETE CASCADE
      );`);

    await client.query('COMMIT');
    console.log('Create tables completed')
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Table creation failed, rolled back:', error.message);
  } finally {
    client.release();
    await pool.end();
  }
}

await createTables();