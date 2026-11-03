import pool from './pool.js';
import pgvector from 'pgvector/pg';
import path from 'node:path';

import { insertDocumentDb } from './documentsQueries.js';
import { insertChunkDb } from './chunksQueries.js';
import { requestEmbedding } from '../services/llm.js';
import { splitMarkdown } from '../services/textChunker.js';
import { extractMarkdownFromFile } from '../services/fileProcessor.js';

const pdfFilename = 'rsn_wiki_text.pdf';

const testPdfPath = path.join(import.meta.dirname, pdfFilename);

/**
 * To set up a clean and reproducible DB state.
 * Clears the documents and chunks table in the DB.
 * Uploads the test PDF.
 */
async function seedDb() {
  // Run the SQL transaction on one single client.
  // If the other queries had used pool.query, it might be a diff client ie the one thats free
  const client = await pool.connect();
  await pgvector.registerTypes(client);

  try {
    await client.query('BEGIN');

    // Truncate chunks first in case any FK issues arise.
    await client.query('TRUNCATE TABLE chunks RESTART IDENTITY CASCADE');
    await client.query('TRUNCATE TABLE documents RESTART IDENTITY CASCADE');

    // Insert test PDF to documents and chunks
    const extractText = await extractMarkdownFromFile(testPdfPath, pdfFilename);

    const docResult = await client.query(
      'INSERT INTO documents (name) VALUES ($1) RETURNING id',
      [pdfFilename],
    );
    const docId = docResult.rows[0].id;

    const chunks = await splitMarkdown(extractText);
    for (const chunk of chunks) {
      const embedding = await requestEmbedding(chunk);
      // const chunkId = await insertChunkDb(docId, chunk, embedding);

      await client.query(
        'INSERT INTO chunks (document_id, content, embedding) VALUES ($1, $2, $3) RETURNING id',
        [docId, chunk, pgvector.toSql(embedding)],
      );
    }
    await client.query('COMMIT');
    console.log(
      `Seeded document ${pdfFilename}. With id: ${docId}. Chunks inserted: ${chunks.length}`,
    );
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Seed failed, rolled back:', error.message);
  } finally {
    client.release();
    await pool.end();
  }
}

await seedDb();
console.log('Script complete'); // only runs after seedDb finishes
