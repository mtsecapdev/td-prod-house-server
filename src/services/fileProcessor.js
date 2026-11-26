import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import AppError from '../utils/AppError.js';
import config from '../config.js';

const execFileAsync = promisify(execFile);
const PAGES_PER_CHUNK = 25;
// Docling inserts this between pages; we strip it and keep page start offsets instead.
const PAGE_BREAK = '<!-- page-break -->';
const SPLIT_SCRIPT = path.join(import.meta.dirname, '../../scripts/split_pdf.py');
const PREPARE_SCRIPT = path.join(import.meta.dirname, '../../scripts/prepare_pdf.py');
// Embedded images in docling's markdown mark where each figure sits.
const EMBEDDED_IMAGE_RE = /!\[[^\]]*\]\(data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+\)/g;
// A figure is kept when it has a caption, readable text inside (a diagram), or is large (an illustration docling
// did not link to its caption). Small uncaptioned images with little text are decoration: logos, icons, banners.
// Anything kept by mistake can be deleted on the Assets page.
const MIN_FIGURE_LABELS = 3;
const MIN_FIGURE_SIDE = 300; // px at images_scale 2, i.e. about 2 inches on the page
const MAX_FIGURE_TEXT = 1500;
// A figure's own caption, as documents print it: "Figure 2-4 - Two-stroke-cycle engine."
const NUMBERED_CAPTION_RE = /\bFig(?:ure)?\.?\s*([A-Z]?\d+(?:[.-]\d+)*[a-z]?)\s*[-–—:]\s*([^\n;]{3,140}?)\s*(?:\.(?=\s|$)|\n|;|$)/gi;
const hasFigureNumber = (caption) => /\bfig(?:ure)?\.?\s*[A-Z]?\d/i.test(caption || '');

export async function extractMarkdownFromFile(filePath, filename, onProgress) {
  if (path.extname(filename).toLowerCase() !== '.pdf') {
    if (onProgress) onProgress({ phase: 'converting', message: 'Converting document...' });
    return mergeRepeatedFigures(await extractMarkdownFromBuffer(await fs.readFile(filePath), filename));
  }
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tdph-prep-'));
  try {
    const source = await preparePdf(filePath, tmpDir);
    const buffer = await fs.readFile(source);
    const pageCount = await getPdfPageCount(buffer);
    if (pageCount > PAGES_PER_CHUNK) return mergeRepeatedFigures(await extractLargePdf(source, filename, pageCount, onProgress));
    if (onProgress) onProgress({ phase: 'converting', message: 'Converting document...' });
    return mergeRepeatedFigures(await extractMarkdownFromBuffer(buffer, filename));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Illustrations stored in media annotations (interactive course PDFs) are drawn into the pages so docling sees
 * them. Returns the path to convert: a prepared copy, or the original when there was nothing to do or it failed.
 */
async function preparePdf(filePath, tmpDir) {
  const out = path.join(tmpDir, 'prepared.pdf');
  try {
    const { stdout } = await execFileAsync(config.pythonPath, [PREPARE_SCRIPT, filePath, out], { timeout: 120_000 });
    const { baked } = JSON.parse(stdout);
    if (!baked) return filePath;
    console.log(`Drew ${baked} media annotation(s) into the pages so their pictures are found`);
    return out;
  } catch (err) {
    console.warn(`PDF preparation skipped (${err.message.split('\n')[0]})`);
    return filePath;
  }
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
    const { stdout } = await execFileAsync(config.pythonPath, [SPLIT_SCRIPT, filePath, tmpDir, String(PAGES_PER_CHUNK)], { timeout: 60_000 });
    const { chunks } = JSON.parse(stdout);

    let allMarkdown = '';
    const allPageStarts = [];
    const allFigures = [];
    let pageOffset = 0;

    for (let i = 0; i < chunks.length; i++) {
      if (onProgress) onProgress({ phase: 'converting', current: i + 1, total: chunks.length, message: `Converting section ${i + 1} of ${chunks.length}...` });
      const chunkPath = path.join(tmpDir, chunks[i]);
      const chunkBuffer = await fs.readFile(chunkPath);
      const { markdown, pageStarts, figures } = await extractMarkdownFromBuffer(chunkBuffer, chunks[i]);

      if (allMarkdown) allMarkdown += '\n\n';
      const base = allMarkdown.length;
      allMarkdown += markdown;

      for (const p of pageStarts) {
        allPageStarts.push({ page: p.page + pageOffset, offset: p.offset + base });
      }
      for (const f of figures) allFigures.push({ ...f, page: f.page != null ? f.page + pageOffset : null });
      pageOffset += PAGES_PER_CHUNK;
    }

    return { markdown: allMarkdown, pageCount: totalPages, pageStarts: allPageStarts, figures: allFigures };
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
  // JSON output gives the page count and each figure's caption, inner text and image.
  form.append('to_formats', 'json');
  form.append('md_page_break_placeholder', PAGE_BREAK);
  // Figure images inline (JSON and markdown); in the markdown they also mark where each figure sits.
  form.append('image_export_mode', 'embedded');
  form.append('images_scale', '2');

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
    const figures = extractFigures(data.document?.json_content);
    const { markdown, pageStarts } = splitPages(placeFigures(data.document.md_content, figures));
    const pageCount = extractPageCount(data);

    return { markdown, pageCount, pageStarts, figures: figures.filter((f) => f.keep).map(({ keep: _k, ...f }) => f) };
  } catch (err) {
    throw new AppError(
      `Docling service error. Original error message: ${err.message}`,
      err.statusCode ?? 503,
      err,
    );
  }
}

/**
 * Each picture docling found, in document order: caption, the text printed inside it (labels of a diagram,
 * which docling leaves out of the markdown), page, and the PNG.
 */
function extractFigures(doc) {
  if (!doc?.pictures?.length) return [];
  const texts = new Map((doc.texts || []).map((t) => [t.self_ref, t.text]));
  return doc.pictures.map((pic) => {
    const caption = (pic.captions || []).map((c) => texts.get(c.$ref)).filter(Boolean).join(' ').trim();
    const labels = (pic.children || [])
      .map((c) => texts.get(c.$ref))
      .filter((t) => t && t.trim() && t.trim() !== caption)
      .map((t) => t.replace(/^[•▪◦·-]\s*/, '').trim());
    const uri = pic.image?.uri || '';
    const png = uri.startsWith('data:image/') ? Buffer.from(uri.split(',', 2)[1], 'base64') : null;
    const width = Math.round(pic.image?.size?.width || 0);
    const height = Math.round(pic.image?.size?.height || 0);
    const large = width >= MIN_FIGURE_SIDE && height >= MIN_FIGURE_SIDE;
    const keep = Boolean(png) && (Boolean(caption) || labels.length >= MIN_FIGURE_LABELS || large);
    return {
      key: png ? crypto.createHash('sha256').update(png).digest('hex').slice(0, 16) : null,
      page: pic.prov?.[0]?.page_no ?? null,
      caption,
      labels: labels.join('; ').slice(0, MAX_FIGURE_TEXT),
      png,
      width,
      height,
      keep,
    };
  });
}

/**
 * Replaces each embedded image in docling's markdown with the figure's text, so the caption and the words
 * inside a diagram become searchable and quotable. A comment marker links the passage to the stored image.
 * The n-th image in the markdown is the n-th picture in the JSON. Captions docling missed are recovered first
 * (ownCaption).
 */
function placeFigures(markdown, figures) {
  const images = [...markdown.matchAll(EMBEDDED_IMAGE_RE)];
  const numbered = new Set(figures.map((f) => figureNumberOf(f.caption)).filter(Boolean));
  images.forEach((m, i) => {
    const f = figures[i];
    if (!f) return;
    // The text between this figure and its neighbours: where a caption docling did not link to it is printed.
    const after = markdown.slice(m.index + m[0].length, images[i + 1]?.index ?? markdown.length).slice(0, 500);
    const before = markdown.slice(images[i - 1] ? images[i - 1].index + images[i - 1][0].length : 0, m.index).slice(-300);
    ownCaption(f, { after, before, numbered });
    if (!f.keep && hasFigureNumber(f.caption) && f.png) f.keep = true; // a figure the document numbers is not decoration
  });
  let n = 0;
  return markdown.replace(EMBEDDED_IMAGE_RE, () => {
    const f = figures[n++];
    if (!f?.keep) return '';
    const title = !f.caption ? 'Figure' : /^fig(ure)?\b/i.test(f.caption) ? f.caption : `Figure: ${f.caption}`;
    return `<!-- figure:${f.key} -->\n${title}${f.labels ? `\nText in the figure: ${f.labels}` : ''}\n`;
  });
}

const figureNumberOf = (text) => (String(text || '').match(/\bfig(?:ure)?\.?\s*([A-Z]?\d+(?:[.-]\d+)*[a-z]?)/i)?.[1] || '').toLowerCase() || null;

/**
 * Gives a figure its numbered caption when docling missed it: docling left the engine manual's two-stroke engine
 * (Figure 2-4) uncaptioned and captioned the V-8 photo with words printed in it ('"V" Type Engine Block')
 * instead of "Figure 2-5 - Engine block designs". The caption is looked for in the words docling read inside
 * the figure, then in the text right after it, then right before; one already belonging to another figure is
 * skipped. A caption without a figure number that is replaced moves to the figure's words.
 */
function ownCaption(f, { after, before, numbered }) {
  if (hasFigureNumber(f.caption)) return;
  const strip = (t) => t.replace(EMBEDDED_IMAGE_RE, ' ');
  const candidates = [
    ...[...f.labels.matchAll(NUMBERED_CAPTION_RE)],
    ...[...strip(after).matchAll(NUMBERED_CAPTION_RE)],
    ...[...strip(before).matchAll(NUMBERED_CAPTION_RE)].reverse(),
  ];
  const found = candidates.find((c) => !numbered.has(c[1].toLowerCase()));
  if (!found) return;
  const caption = `Figure ${found[1]} - ${found[2].trim()}`;
  if (f.caption) f.labels = [f.caption, f.labels].filter(Boolean).join('; ').slice(0, MAX_FIGURE_TEXT);
  f.caption = caption;
  numbered.add(found[1].toLowerCase());
}

/**
 * A figure printed twice (the engine manual shows its four-stroke figure as both 2-3 and 2-10) is kept once:
 * same caption apart from its number, and the same words inside. Its later places in the text point to the
 * first, so a deck never shows the same picture twice as two figures.
 */
function mergeRepeatedFigures(result) {
  const sameness = (f) => {
    const caption = String(f.caption || '').replace(/^\s*fig(?:ure)?\.?\s*[A-Z]?\d+(?:[.-]\d+)*[a-z]?\s*[-–—:.]?\s*/i, '').trim().toLowerCase();
    const labels = String(f.labels || '').trim().toLowerCase();
    return caption.length >= 8 || labels.split(';').length >= 3 ? `${caption}|${labels}` : null;
  };
  const first = new Map();
  const figures = [];
  let { markdown } = result;
  for (const f of result.figures) {
    const key = sameness(f);
    const kept = key && first.get(key);
    if (kept) {
      markdown = markdown.replaceAll(`<!-- figure:${f.key} -->`, `<!-- figure:${kept.key} -->`);
      continue;
    }
    if (key) first.set(key, f);
    figures.push(f);
  }
  return { ...result, markdown, figures };
}

function extractPageCount(data) {
  try {
    const doc = data.document?.json_content;
    const pages = doc?.pages;
    if (pages && Object.keys(pages).length) return Object.keys(pages).length;
    let max = 0;
    for (const item of doc?.texts ?? []) {
      const p = item.prov?.[0]?.page_no ?? 0;
      if (p > max) max = p;
    }
    return max || null;
  } catch {
    return null;
  }
}

/**
 * Removes docling's page-break placeholders and records where each page starts in the
 * resulting markdown, so chunks can be assigned pages by position (tables included).
 * @returns {{ markdown: string, pageStarts: { page: number, offset: number }[] }}
 */
function splitPages(rawMarkdown) {
  const pages = rawMarkdown.split(PAGE_BREAK).map(cleanMarkdown);
  // Docling also emits a placeholder after the last page.
  while (pages.length > 1 && pages[pages.length - 1] === '') pages.pop();

  let markdown = '';
  const pageStarts = [];
  pages.forEach((text, i) => {
    if (markdown && text) markdown += '\n\n';
    pageStarts.push({ page: i + 1, offset: markdown.length });
    markdown += text;
  });
  return { markdown, pageStarts };
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
