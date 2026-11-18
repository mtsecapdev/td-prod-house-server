// Figures from ingested documents: saved at ingestion, linked to passages by a marker, shown under chat answers.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import config from '../config.js';
import { insertFigureDb, getFiguresByKeysDb } from '../db/figuresQueries.js';

const MARKER_RE = /<!-- figure:([a-f0-9]{16}) -->\n?/g;

function figureDir(documentId) {
  return join(config.outputDir, 'figures', String(Number(documentId)));
}

/** Writes each figure's PNG and records it. */
export async function saveFigures(documentId, figures) {
  if (!figures?.length) return 0;
  const dir = figureDir(documentId);
  await mkdir(dir, { recursive: true });
  for (const f of figures) {
    const filePath = join(dir, `${f.key}.png`);
    await writeFile(filePath, f.png);
    await insertFigureDb(documentId, { ...f, filePath });
  }
  return figures.length;
}

export async function deleteFigureFiles(documentId) {
  await rm(figureDir(documentId), { recursive: true, force: true });
}

/** A figure's caption as shown under it on a slide/page: the document's own caption ("FIGURE 2.1-1 ..." → "Figure 2.1-1 ..."). */
export function figureCaption(caption) {
  return String(caption || '').replace(/^FIGURE\b/, 'Figure').replace(/\s+/g, ' ').trim();
}

/**
 * A picture on a slide/section: a document figure with its caption (the document's own, else `fallback`, e.g. one
 * the writer made for an uncaptioned figure). Position/size/crop are added by the editor.
 */
export function pictureOf(figure, fallback = '') {
  return { figure_id: figure.id, caption: figureCaption(figure.caption) || String(fallback || '').trim() };
}

/** Passage text without figure markers (for the model and for display). */
export function stripFigureMarkers(text) {
  return String(text || '').replace(MARKER_RE, '');
}

/** The figures contained in a set of passages ({ document_id, content }). */
export async function figuresInChunks(chunks) {
  const pairs = [];
  const seen = new Set();
  for (const c of chunks) {
    for (const m of String(c.content || '').matchAll(MARKER_RE)) {
      const id = `${c.document_id}:${m[1]}`;
      if (!seen.has(id)) { seen.add(id); pairs.push({ documentId: c.document_id, key: m[1] }); }
    }
  }
  return getFiguresByKeysDb(pairs);
}

// "FIGURE 2.0-1 SE in Context..." -> "2.0-1"; null when the caption has no figure number.
export function figureNumber(caption) {
  return String(caption || '').match(/\bfig(?:ure)?\.?\s*([A-Z]?\d+(?:[.-]\d+)*[a-z]?)/i)?.[1] || null;
}

/** The figures an answer actually refers to: by number ("Figure 2.0-1") or, without one, by caption. */
export function figuresMentioned(figures, answer) {
  const text = String(answer || '').toLowerCase();
  return figures.filter((f) => {
    const n = figureNumber(f.caption);
    if (n) return new RegExp(`\\bfig(?:ure)?\\.?\\s*${n.replace(/[.-]/g, '[.-]')}\\b`, 'i').test(answer);
    const cap = f.caption.toLowerCase().slice(0, 40).trim();
    return cap.length >= 12 && text.includes(cap);
  });
}
