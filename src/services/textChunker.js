import { MarkdownTextSplitter } from '@langchain/textsplitters';

const CHUNK_SIZE = 2000;
const CHUNK_OVERLAP = 200;

const markdownSplitter = new MarkdownTextSplitter({
  chunkSize: CHUNK_SIZE,
  chunkOverlap: CHUNK_OVERLAP,
  keepSeparator: true,
});

const HEADING_RE = /^#{1,6}\s+(.+)$/gm;

/**
 * Splits markdown into chunks and labels each with the page and section heading in effect where
 * the chunk starts. Both come from the chunk's position in the document, so a chunk that
 * continues a table or section still gets the right page and heading.
 * @param {string} markdown
 * @param {{ page: number, offset: number }[]} pageStarts  from fileProcessor, ascending by offset
 * @returns {Promise<{ text: string, page: number | null, heading: string | null }[]>}
 */
export async function splitMarkdown(markdown, pageStarts = []) {
  const rawChunks = await markdownSplitter.splitText(markdown);
  const filtered = rawChunks.filter((chunk) => chunk.trim().length > 100);
  const headings = [...markdown.matchAll(HEADING_RE)].map((m) => ({ offset: m.index, text: m[1].trim() }));

  let searchFrom = 0;
  return filtered.map((text) => {
    const offset = findOffset(markdown, text, searchFrom);
    if (offset === -1) {
      // Should not happen; fall back to what the chunk itself contains.
      return { text, page: null, heading: extractHeading(text) };
    }
    searchFrom = offset + 1; // chunks are in order; overlap means the next one starts after this start
    return {
      text: markPages(text, markdown, offset, pageStarts),
      page: lastAtOrBefore(pageStarts, offset)?.page ?? null,
      heading: lastAtOrBefore(headings, offset)?.text ?? null,
    };
  });
}

/**
 * A chunk is labelled with the page it starts on, but can run onto the next page ("Talent, p. 21" also held the
 * p. 22 outlook), so answers cited the wrong page. Each page that starts inside the chunk gets a "[p. N]" line
 * where it begins. Inside a table the mark waits until the table ends, so the table stays intact.
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

// The splitter can normalise whitespace where it joins pieces, so match on the chunk's opening text.
function findOffset(markdown, chunk, from) {
  const probe = chunk.trimStart().slice(0, 80);
  const at = markdown.indexOf(probe, from);
  return at !== -1 ? at : markdown.indexOf(probe);
}

function lastAtOrBefore(items, offset) {
  let found = null;
  for (const item of items) {
    if (item.offset > offset) break;
    found = item;
  }
  return found;
}

function extractHeading(text) {
  const match = text.match(/^(#{1,3})\s+(.+)$/m);
  return match ? match[2].trim() : null;
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
