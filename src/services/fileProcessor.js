import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import AppError from '../utils/AppError.js';
import config from '../config.js';

const execFileAsync = promisify(execFile);
const PAGES_PER_CHUNK = 25;
const SPLIT_SCRIPT = path.join(import.meta.dirname, '../../scripts/split_pdf.py');

export async function extractMarkdownFromFile(filePath, filename, onProgress) {
  if (path.extname(filename).toLowerCase() === '.pdf') {
    const buffer = await fs.readFile(filePath);
    const pageCount = await getPdfPageCount(buffer);
    if (pageCount > PAGES_PER_CHUNK) {
      return extractLargePdf(filePath, filename, pageCount, onProgress);
    }
  }
  if (onProgress) onProgress({ phase: 'converting', message: 'Converting document...' });
  const buffer = await fs.readFile(filePath);
  return extractMarkdownFromBuffer(buffer, filename);
}

async function getPdfPageCount(buffer) {
  const header = buffer.slice(0, 20).toString();
  if (!header.startsWith('%PDF')) return 0;
  const text = buffer.toString('latin1');
  const matches = text.match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : 0;
}

async function extractLargePdf(filePath, filename, totalPages, onProgress) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tdph-split-'));
  try {
    if (onProgress) onProgress({ phase: 'splitting', message: `Splitting ${totalPages}-page PDF...` });
    const { stdout } = await execFileAsync('python', [SPLIT_SCRIPT, filePath, tmpDir, String(PAGES_PER_CHUNK)], { timeout: 60_000 });
    const { chunks } = JSON.parse(stdout);

    let allMarkdown = '';
    const allMarkers = [];
    let pageOffset = 0;

    for (let i = 0; i < chunks.length; i++) {
      if (onProgress) onProgress({ phase: 'converting', current: i + 1, total: chunks.length, message: `Converting section ${i + 1} of ${chunks.length}...` });
      const chunkPath = path.join(tmpDir, chunks[i]);
      const chunkBuffer = await fs.readFile(chunkPath);
      const { markdown, pageMarkers } = await extractMarkdownFromBuffer(chunkBuffer, chunks[i]);

      allMarkdown += (allMarkdown ? '\n\n' : '') + markdown;

      for (const m of pageMarkers) {
        allMarkers.push({ page: m.page + pageOffset, snippet: m.snippet });
      }
      pageOffset += PAGES_PER_CHUNK;
    }

    return { markdown: allMarkdown, pageCount: totalPages, pageMarkers: allMarkers };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Takes in a file's buffer and returns the text as markdown. To help with a structured chunking strategy.
 * @param {Buffer<ArrayBufferLike>} buffer
 * @param {string} filename
 * @returns {string} Parsed text in markdown format.
 */
export async function extractMarkdownFromBuffer(buffer, filename) {
  const form = new FormData();
  const blob = new Blob([buffer]);
  form.append('files', blob, filename);
  form.append('to_formats', 'md');

  try {
    const res = await fetch(config.docling.endpoint, {
      method: 'POST',
      body: form,
    });

    if (!res.ok) {
      throw new Error(
        `Docling promise rejected. Status text: ${res.statusText}`,
      );
    }

    const data = await res.json();
    const md = cleanMarkdown(data.document.md_content);
    const pageCount = extractPageCount(data);
    const pageMarkers = extractPageMarkers(data);

    return { markdown: md, pageCount, pageMarkers };
  } catch (err) {
    throw new AppError(
      `Docling service error. Original error message: ${err.message}`,
      err.statusCode ?? 503,
      err,
    );
  }
}

function extractPageCount(data) {
  try {
    const pages = data.document?.pages;
    if (pages) return Object.keys(pages).length;
    const items = data.document?.body || data.document?.texts || [];
    let max = 0;
    for (const item of items) {
      const p = item.prov?.[0]?.page ?? item.page_no ?? 0;
      if (p > max) max = p;
    }
    return max || null;
  } catch {
    return null;
  }
}

function extractPageMarkers(data) {
  try {
    const items = data.document?.body || data.document?.texts || [];
    const markers = [];
    for (const item of items) {
      const page = item.prov?.[0]?.page ?? item.page_no;
      if (page && item.text) {
        markers.push({ page, snippet: item.text.slice(0, 80) });
      }
    }
    return markers;
  } catch {
    return [];
  }
}

function cleanMarkdown(markdown) {
  return (
    markdown
      // Remove image placeholders
      .replace(/<!--\s*image\s*-->/gi, '')
      // Remove reference list lines (e.g. "41. [Some citation](url)")
      .replace(/^\d+\.\s+\[.*?\]\(.*?\).*$/gm, '')
      // Remove bare URLs left after ref removal
      .replace(/^https?:\/\/\S+$/gm, '')
      // Remove copyright/boilerplate lines
      .replace(/^.*all rights reserved.*$/gim, '')
      .replace(/^.*no part of this.*$/gim, '')
      // Collapse 3+ newlines into 2
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}
