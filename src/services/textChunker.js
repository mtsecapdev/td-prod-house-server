import { MarkdownTextSplitter } from '@langchain/textsplitters';

const CHUNK_SIZE = 2000;
const CHUNK_OVERLAP = 200;

const markdownSplitter = new MarkdownTextSplitter({
  chunkSize: CHUNK_SIZE,
  chunkOverlap: CHUNK_OVERLAP,
  keepSeparator: true,
});

/**
 * @param {string} markdown
 * @param {{ page: number, snippet: string }[]} pageMarkers
 * @returns {{ text: string, page: number | null, heading: string | null }[]}
 */
export async function splitMarkdown(markdown, pageMarkers = []) {
  const rawChunks = await markdownSplitter.splitText(markdown);
  const filtered = rawChunks.filter((chunk) => chunk.trim().length > 100);

  return filtered.map((text) => {
    const page = guessPage(text, pageMarkers);
    const heading = extractHeading(text);
    return { text, page, heading };
  });
}

function guessPage(chunkText, markers) {
  if (!markers.length) return null;
  const sample = chunkText.slice(0, 120);
  let best = null;
  let bestScore = 0;
  for (const m of markers) {
    const words = m.snippet.split(/\s+/).slice(0, 6);
    let matches = 0;
    for (const w of words) {
      if (w.length > 3 && sample.includes(w)) matches++;
    }
    if (matches > bestScore) {
      bestScore = matches;
      best = m.page;
    }
  }
  return best;
}

function extractHeading(text) {
  const match = text.match(/^(#{1,3})\s+(.+)$/m);
  return match ? match[2].trim() : null;
}

export function enrichTextForEmbedding(text, { page, heading } = {}) {
  const parts = [];
  if (heading) parts.push(heading);
  if (page != null) parts.push(`Page ${page}`);
  if (parts.length === 0) return text;
  return `[${parts.join(' | ')}] ${text}`;
}
