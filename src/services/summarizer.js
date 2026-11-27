// Writing about a document, as opposed to the document itself:
// - its overview: one paragraph on what it is about, written when it is imported (shown to the model reading a
//   chat message, used for the planning interview's suggestions).
// - section summaries: 2-3 sentences per section, written only when a whole-document answer needs them for a
//   document too long to read in full (wholeDocument.js), then kept. They used to be written for every section
//   of every upload (the heaviest part of an import) and mixed into search as if they were the document.
// Neither is searched or used as evidence: answers and slides are built from the document's own text.
import { generateStructured } from './llm.js';
import { readablePassage } from './figures.js';
import { getAllPassagesDb, getSectionSummariesDb, insertChunkDb } from '../db/chunksQueries.js';
import config from '../config.js';

const { generateModel } = config.ollama;

// The overview reads the whole text when it is this short, otherwise each section's opening.
const OVERVIEW_CHARS = 40000;
const SECTION_OPENING_CHARS = 600;
const SECTIONS_PER_BATCH = 8;
// Text shown per section (8 per call: up to ~48k characters, ~13k tokens, inside the 32k context with the reply).
const SECTION_CHARS = 6000;

/** The document's sections in reading order: [{ section, heading, passages }]. */
function sectionsOf(passages) {
  const sections = [];
  for (const p of passages) {
    const last = sections[sections.length - 1];
    if (last && last.section === p.section) last.passages.push(p);
    else sections.push({ section: p.section, heading: p.heading, passages: [p] });
  }
  return sections;
}

/** Writes and stores the document's overview. */
export async function writeOverview(docId) {
  const passages = await getAllPassagesDb([docId]);
  if (!passages.length) return;
  const full = passages.map((p) => readablePassage(p.content)).join('\n\n');
  const material = full.length <= OVERVIEW_CHARS
    ? full
    : sectionsOf(passages)
      .map((s) => `## ${s.heading || 'Section'}\n${readablePassage(s.passages[0].content).slice(0, SECTION_OPENING_CHARS)}`)
      .join('\n\n')
      .slice(0, OVERVIEW_CHARS);
  const prompt =
    `Below is a document${full.length <= OVERVIEW_CHARS ? '' : ' (the opening of each section)'}. Write an overview ` +
    `of it in one paragraph (4-6 sentences): what it is, its purpose, and the main topics it covers. State only ` +
    `what the text says.\n\n${material}`;
  const schema = { type: 'object', properties: { overview: { type: 'string' } }, required: ['overview'] };
  const { overview } = await generateStructured(prompt, generateModel, schema, { think: false });
  await insertChunkDb(docId, overview.trim(), null, { heading: 'Document Overview', level: 'document' });
}

/** The document's section summaries, written now if it has none yet. */
export async function ensureSectionSummaries(docId) {
  const existing = await getSectionSummariesDb([docId]);
  if (existing.length) return existing;
  const sections = sectionsOf(await getAllPassagesDb([docId]));
  for (let i = 0; i < sections.length; i += SECTIONS_PER_BATCH) {
    const batch = sections.slice(i, i + SECTIONS_PER_BATCH);
    const summaries = await summarizeBatch(batch);
    for (let k = 0; k < batch.length; k++) {
      await insertChunkDb(docId, summaries[k], null, {
        page: batch[k].passages[0].page, heading: batch[k].heading || 'Section', level: 'section', section: batch[k].section,
      });
    }
  }
  return getSectionSummariesDb([docId]);
}

// Summaries run without thinking (a large document has dozens of these calls) and as JSON: with thinking off,
// qwen3 reasons out loud in plain-text replies, which would end up in the stored summary. Answers are matched by
// section number, not position, so a skipped answer can't shift every later summary onto the wrong section.
async function summarizeBatch(sections) {
  const parts = sections.map((section, i) => {
    const label = section.heading || `Section ${i + 1}`;
    // Whole sections up to SECTION_CHARS. Cut shorter, the Norvane incident log showed rows 1-26 of 49 and the
    // summary called that the total. When a section is still cut, it says so, so the summary gives no totals.
    const full = section.passages.map((p) => readablePassage(p.content)).join('\n');
    const text = full.length > SECTION_CHARS
      ? `${full.slice(0, SECTION_CHARS)}\n[THIS SECTION CONTINUES; the rest is not shown]`
      : full;
    return `### ${i + 1}. ${label}\n${text}`;
  });

  const prompt =
    `Summarize each of the following ${sections.length} document sections in 2-3 concise sentences each, ` +
    `capturing the key facts and topics. State only facts that appear in the section's text; never guess a ` +
    `date, number or name. A section marked "THIS SECTION CONTINUES" is cut short: describe what it contains, ` +
    `but give no totals, counts or ranges for it, since you have not seen all of it. n is the section's number.\n\n` +
    parts.join('\n\n');
  const schema = {
    type: 'object',
    properties: {
      summaries: {
        type: 'array',
        minItems: sections.length,
        maxItems: sections.length,
        items: {
          type: 'object',
          properties: { n: { type: 'integer' }, summary: { type: 'string' } },
          required: ['n', 'summary'],
        },
      },
    },
    required: ['summaries'],
  };

  const result = await generateStructured(prompt, generateModel, schema, { think: false });
  const byNumber = new Map((result.summaries || []).map((x) => [x.n, x.summary?.trim()]));
  // A section the model left out gets its opening text rather than a neighbour's summary.
  return sections.map((section, i) => byNumber.get(i + 1)
    || readablePassage(section.passages[0].content).replace(/\s+/g, ' ').slice(0, 300));
}
