import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import pool from '../db/pool.js';
import pgvector from 'pgvector/pg';
import config from '../config.js';
import { extractMarkdownFromFile } from '../services/fileProcessor.js';
import { splitMarkdown } from '../services/textChunker.js';
import { requestEmbedding } from '../services/llm.js';
import {
  getDocumentByHashDb,
  insertDocumentDb,
  updateDocumentStatusDb,
  deleteDocumentDb,
} from '../db/documentsQueries.js';
import { insertChunkDb } from '../db/chunksQueries.js';

const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.docx', '.pptx', '.md', '.txt']);

async function hashFile(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function discoverFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    console.error(`Cannot read sources directory: ${dir}`);
    return [];
  }

  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await discoverFiles(full));
    } else if (SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(full);
    }
  }
  return files;
}

async function ingestFile(filePath) {
  const filename = path.basename(filePath);
  const fileHash = await hashFile(filePath);

  const existing = await getDocumentByHashDb(fileHash);
  if (existing) {
    console.log(`  Skipped (unchanged): ${filename}`);
    return { status: 'skipped', filename };
  }

  const docId = await insertDocumentDb(filename, { filePath, fileHash, status: 'processing' });
  console.log(`  Processing: ${filename} (doc ${docId})`);

  try {
    const markdown = await extractMarkdownFromFile(filePath, filename);
    const chunks = await splitMarkdown(markdown);

    for (const chunk of chunks) {
      const embedding = await requestEmbedding(chunk);
      await insertChunkDb(docId, chunk, embedding);
    }

    await updateDocumentStatusDb(docId, 'ready');
    console.log(`  Done: ${filename} — ${chunks.length} chunks`);
    return { status: 'ingested', filename, chunks: chunks.length };
  } catch (err) {
    await updateDocumentStatusDb(docId, 'failed', err.message);
    console.error(`  Failed: ${filename} — ${err.message}`);
    return { status: 'failed', filename, error: err.message };
  }
}

async function main() {
  const dir = config.sourcesDir;
  console.log(`Scanning: ${dir}`);

  const files = await discoverFiles(dir);
  if (files.length === 0) {
    console.log('No supported files found.');
    await pool.end();
    return;
  }

  console.log(`Found ${files.length} file(s)\n`);

  const results = { ingested: 0, skipped: 0, failed: 0 };
  for (const file of files) {
    const result = await ingestFile(file);
    results[result.status]++;
  }

  console.log(`\nDone — ingested: ${results.ingested}, skipped: ${results.skipped}, failed: ${results.failed}`);
  await pool.end();
}

await main();
