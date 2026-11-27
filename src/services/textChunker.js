// Splits a document's markdown into passages: one per section (the text under a heading), so search, planning
// and answers work with whole sections. Fixed-size pieces cut sections apart (the engine manual's combustion
// chamber section lost its second half, swirl chambers and energy cells, to the next piece), and every reader
// had to stitch them back together. A section longer than MAX_PASSAGE is split at paragraph breaks into parts
// of the same section, without overlap; a heading with almost nothing under it joins the next section.

// Characters per passage at most. Sections of the documents seen so far are mostly 1-3k characters.
const MAX_PASSAGE = 4000;
// A section with less text than this under its heading ("3.3.0 Engine Performance" followed straight away by
// "3.3.1 Compression Ratio") joins the section after it.
const MIN_SECTION = 200;
// Passages with less text than this are left out (a stray page header, an empty heading at the end).
const MIN_PASSAGE = 40;

const HEADING_LINE_RE = /^#{1,6}\s+(.+)$/gm;

/**
 * Splits markdown into passages labelled with the page they start on, their section's heading and its number.
 * @param {string} markdown
 * @param {{ page: number, offset: number }[]} pageStarts  from fileProcessor, ascending by offset
 * @returns {{ text: string, page: number | null, heading: string | null, section: number }[]}
 */
export function splitMarkdown(markdown, pageStarts = []) {
  const passages = [];
  sectionsOf(markdown).forEach((section, i) => {
    for (const part of partsOf(markdown, section)) {
      const raw = markdown.slice(part.start, part.end);
      const start = part.start + (raw.length - raw.trimStart().length);
      const text = raw.trim();
      if (text.replace(/\s+/g, '').length < MIN_PASSAGE) continue;
      passages.push({
        text: markPages(text, markdown, start, pageStarts),
        page: lastAtOrBefore(pageStarts, start)?.page ?? null,
        heading: section.heading,
        section: i + 1,
      });
    }
  });
  return passages;
}

/** The document's sections: [start, end) offsets and heading, small ones joined to the next. */
function sectionsOf(markdown) {
  const heads = [...markdown.matchAll(HEADING_LINE_RE)].map((m) => ({ start: m.index, heading: m[1].trim(), body: m.index + m[0].length }));
  const raw = [];
  if (!heads.length || heads[0].start > 0) raw.push({ start: 0, heading: null, body: 0 });
  raw.push(...heads);
  const sections = raw.map((s, i) => ({ ...s, end: raw[i + 1]?.start ?? markdown.length }));

  const joined = [];
  let pending = null; // small sections waiting to join the next one
  for (const s of sections) {
    const section = pending ? { ...s, start: pending.start } : s;
    const bodyChars = markdown.slice(s.body, s.end).replace(/\s+/g, '').length;
    if (bodyChars < MIN_SECTION && s !== sections[sections.length - 1]) {
      pending = section; // its text (heading included) goes in front of the next section
      continue;
    }
    pending = null;
    joined.push(section);
  }
  return joined;
}

/**
 * A section in parts of at most MAX_PASSAGE characters, cut at paragraph breaks. A table stays in one part
 * unless it alone is too long, in which case it is cut between rows.
 */
function partsOf(markdown, { start, end }) {
  if (end - start <= MAX_PASSAGE) return [{ start, end }];
  // Block boundaries: blank lines, except inside a table.
  const cuts = [];
  const body = markdown.slice(start, end);
  for (const m of body.matchAll(/\n\s*\n/g)) {
    const at = start + m.index + m[0].length;
    const before = markdown.slice(markdown.lastIndexOf('\n', start + m.index - 1) + 1, start + m.index);
    const after = markdown.slice(at, markdown.indexOf('\n', at) === -1 ? end : markdown.indexOf('\n', at));
    if (/^\s*\|/.test(before) && /^\s*\|/.test(after)) continue;
    cuts.push(at);
  }
  cuts.push(end);
  const parts = [];
  let from = start;
  let last = start;
  for (const cut of cuts) {
    if (cut - from > MAX_PASSAGE && last > from) {
      parts.push({ start: from, end: last });
      from = last;
    }
    last = cut;
  }
  parts.push({ start: from, end });
  // A single block still too long (a very long table or paragraph): cut it between lines.
  return parts.flatMap((p) => (p.end - p.start <= MAX_PASSAGE ? [p] : byLines(markdown, p)));
}

function byLines(markdown, { start, end }) {
  const parts = [];
  let from = start;
  let at = start;
  while (at < end) {
    const next = markdown.indexOf('\n', at);
    const lineEnd = next === -1 || next >= end ? end : next + 1;
    if (lineEnd - from > MAX_PASSAGE && at > from) {
      parts.push({ start: from, end: at });
      from = at;
    }
    at = lineEnd;
  }
  parts.push({ start: from, end });
  return parts;
}

/**
 * A passage is labelled with the page it starts on, but can run onto the next page, so answers cited the wrong
 * page. Each page that starts inside the passage gets a "[p. N]" line where it begins. Inside a table the mark
 * waits until the table ends, so the table stays intact.
 */
export const PAGE_MARK_RE = /^\[p\. \d+\]\n?/gm;

function markPages(text, markdown, offset, pageStarts) {
  const end = offset + text.length;
  let out = text;
  for (const ps of pageStarts) {
    if (ps.offset <= offset || ps.offset >= end) continue;
    const probe = markdown.slice(ps.offset, ps.offset + 60).trim().split('\n')[0].slice(0, 40);
    let at = probe ? out.indexOf(probe) : -1;
    if (at === -1) continue;
    at = out.lastIndexOf('\n', at - 1) + 1; // start of that line
    while (/^\s*\|/.test(out.slice(at))) { // a table row: move past the table
      const next = out.indexOf('\n', at);
      if (next === -1) { at = -1; break; }
      at = next + 1;
    }
    if (at <= 0 || at >= out.length) continue;
    out = `${out.slice(0, at)}[p. ${ps.page}]\n${out.slice(at)}`;
  }
  return out;
}

function lastAtOrBefore(items, offset) {
  let found = null;
  for (const item of items) {
    if (item.offset > offset) break;
    found = item;
  }
  return found;
}

// Figure markers ("<!-- figure:KEY -->") link passages to saved figures; they carry no meaning for search.
const FIGURE_MARKER_RE = /<!-- figure:[a-f0-9]{16} -->\n?/g;

export function enrichTextForEmbedding(rawText, { page, heading } = {}) {
  const text = String(rawText).replace(FIGURE_MARKER_RE, '').replace(PAGE_MARK_RE, '');
  const parts = [];
  if (heading) parts.push(heading);
  if (page != null) parts.push(`Page ${page}`);
  if (parts.length === 0) return text;
  return `[${parts.join(' | ')}] ${text}`;
}
