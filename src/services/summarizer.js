import { requestEmbedding, generateStructured } from './llm.js';
import { enrichTextForEmbedding } from './textChunker.js';
import { insertChunkDb } from '../db/chunksQueries.js';
import config from '../config.js';

const { generateModel } = config.ollama;
const SECTIONS_PER_BATCH = 8;

export async function generateSummaryChunks(docId, leafChunks, { onProgress } = {}) {
  const sections = groupBySection(leafChunks);
  const batches = batchSections(sections, SECTIONS_PER_BATCH);
  const sectionSummaries = [];

  for (let b = 0; b < batches.length; b++) {
    if (onProgress) onProgress({ step: 'section', current: b + 1, total: batches.length });

    const batch = batches[b];
    const summaries = await summarizeBatch(batch);

    for (let i = 0; i < batch.length; i++) {
      const section = batch[i];
      const summary = summaries[i];
      const heading = section.heading || `Section`;
      const page = section.chunks[0]?.page ?? null;

      const embeddingText = enrichTextForEmbedding(summary, { page, heading: `Summary: ${heading}` });
      const embedding = await requestEmbedding(embeddingText);
      await insertChunkDb(docId, summary, embedding, {
        page,
        heading: `Summary: ${heading}`,
        level: 'section',
      });

      sectionSummaries.push({ heading, summary });
    }
  }

  if (onProgress) onProgress({ step: 'document' });

  const docSummary = await summarizeDocument(sectionSummaries);
  const embeddingText = enrichTextForEmbedding(docSummary, { heading: 'Document Overview' });
  const embedding = await requestEmbedding(embeddingText);
  await insertChunkDb(docId, docSummary, embedding, {
    heading: 'Document Overview',
    level: 'document',
  });

  return { sectionCount: sectionSummaries.length };
}

function groupBySection(chunks) {
  const sections = [];
  let current = { heading: null, chunks: [] };

  // Continuation chunks carry their section's heading (textChunker), so start a new section
  // only when the heading changes.
  for (const chunk of chunks) {
    if (chunk.heading && chunk.heading !== current.heading && current.chunks.length > 0) {
      sections.push(current);
      current = { heading: chunk.heading, chunks: [chunk] };
    } else {
      if (chunk.heading) current.heading = chunk.heading;
      current.chunks.push(chunk);
    }
  }
  if (current.chunks.length > 0) sections.push(current);

  if (sections.length <= 2 && chunks.length > 10) {
    return chunkEvenly(chunks, Math.ceil(chunks.length / 8));
  }

  return sections;
}

function chunkEvenly(chunks, groupSize) {
  const sections = [];
  for (let i = 0; i < chunks.length; i += groupSize) {
    const group = chunks.slice(i, i + groupSize);
    const heading = group.find((c) => c.heading)?.heading || null;
    sections.push({ heading, chunks: group });
  }
  return sections;
}

function batchSections(sections, batchSize) {
  const batches = [];
  for (let i = 0; i < sections.length; i += batchSize) {
    batches.push(sections.slice(i, i + batchSize));
  }
  return batches;
}

// Summaries run without thinking (a large document has dozens of these calls; thinking made them the slowest
// step of ingestion) and as JSON: with thinking off, qwen3 reasons out loud in plain-text replies, which
// would end up in the stored summary. Answers are matched by section number, not position, so a skipped
// answer can't shift every later summary onto the wrong section.
export async function summarizeBatch(sections) {
  const parts = sections.map((section, i) => {
    const label = section.heading || `Section ${i + 1}`;
    // Without thinking these calls are cheap, so each section gets more of its text: at 1,200 characters,
    // facts in later table rows were cut off and the model guessed them.
    const text = section.chunks
      .map((c) => c.text.slice(0, 1200))
      .join(' ')
      .slice(0, 2400);
    return `### ${i + 1}. ${label}\n${text}`;
  });

  const prompt =
    `Summarize each of the following ${sections.length} document sections in 2-3 concise sentences each, ` +
    `capturing the key facts and topics. State only facts that appear in the section's text; never guess a ` +
    `date, number or name. n is the section's number.\n\n` +
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
    || section.chunks.map((c) => c.text).join(' ').replace(/\s+/g, ' ').slice(0, 300));
}

async function summarizeDocument(sectionSummaries) {
  const list = sectionSummaries
    .map((s) => `${s.heading}: ${s.summary}`)
    .join('\n\n');

  const prompt =
    `Below are summaries of each section of a document. ` +
    `Write a comprehensive overview of the entire document in one paragraph (4-6 sentences). ` +
    `Cover the main topics, purpose, and key content areas.\n\n` +
    list;
  const schema = { type: 'object', properties: { overview: { type: 'string' } }, required: ['overview'] };
  const result = await generateStructured(prompt, generateModel, schema, { think: false });
  return result.overview.trim();
}
