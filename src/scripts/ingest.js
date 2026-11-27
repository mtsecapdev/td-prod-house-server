import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import pool from '../db/pool.js';
import config from '../config.js';
import { runImport } from '../services/imports.js';
import { getDocumentByHashDb, insertDocumentDb, claimImportDb } from '../db/documentsQueries.js';

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

async function ingestFile(filePath, ownerId) {
  const filename = path.basename(filePath);
  const fileHash = await hashFile(filePath);

  const existing = await getDocumentByHashDb(fileHash, ownerId);
  if (existing) {
    console.log(`  Skipped (unchanged): ${filename}`);
    return { status: 'skipped', filename };
  }

  const docId = await insertDocumentDb(filename, { ownerId, filePath, fileHash, status: 'processing' });
  // Taken by this script, so a running app server's import queue leaves it alone.
  await claimImportDb(docId);
  console.log(`  Processing: ${filename} (doc ${docId})`);
  const outcome = await runImport({ id: docId, name: filename, file_path: filePath }, (e) => {
    if (e.message && e.phase !== 'done') process.stdout.write(`\r  ${e.message.padEnd(60)}`);
  });
  process.stdout.write('\n');
  return { status: outcome === 'ready' ? 'ingested' : 'failed', filename };
}

// Documents belong to someone: npm run ingest -- --owner <username>
async function ownerFromArgs() {
  const at = process.argv.indexOf('--owner');
  const username = at > -1 ? process.argv[at + 1] : null;
  if (!username) {
    console.error('Usage: npm run ingest -- --owner <username>   (the account the documents will belong to)');
    process.exit(1);
  }
  const res = await pool.query('SELECT id FROM users WHERE lower(username) = lower($1)', [username]);
  if (!res.rowCount) {
    console.error(`No account named "${username}"`);
    process.exit(1);
  }
  return res.rows[0].id;
}

async function main() {
  const ownerId = await ownerFromArgs();
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
    const result = await ingestFile(file, ownerId);
    results[result.status]++;
  }

  console.log(`\nDone — ingested: ${results.ingested}, skipped: ${results.skipped}, failed: ${results.failed}`);
  await pool.end();
}

await main();
