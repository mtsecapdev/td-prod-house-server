import { requestEmbedding } from './llm.js';
import { enrichTextForEmbedding } from './textChunker.js';
import { insertChunkDb } from '../db/chunksQueries.js';
import config from '../config.js';
import * as provider from './providers/ollama.js';

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
      const summary = summaries[i] || summaries[summaries.length - 1];
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

  for (const chunk of chunks) {
    if (chunk.heading && current.chunks.length > 0) {
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

async function summarizeBatch(sections) {
  const parts = sections.map((section, i) => {
    const label = section.heading || `Section ${i + 1}`;
    const text = section.chunks
      .map((c) => c.text.slice(0, 400))
      .join(' ')
      .slice(0, 1200);
    return `### ${label}\n${text}`;
  });

  const prompt =
    `Summarize each of the following ${sections.length} document sections in 2-3 concise sentences each. ` +
    `Return each summary on its own line, prefixed with the section number (1., 2., etc.). ` +
    `Capture the key facts and topics.\n\n` +
    parts.join('\n\n');

  const raw = await provider.generate(prompt, generateModel, {});
  return parseNumberedList(raw, sections.length);
}

function parseNumberedList(text, expected) {
  const lines = text.split('\n').filter((l) => l.trim());
  const results = [];
  let current = '';

  for (const line of lines) {
    const match = line.match(/^\d+[\.\)]\s*/);
    if (match) {
      if (current) results.push(current.trim());
      current = line.replace(/^\d+[\.\)]\s*/, '');
    } else {
      current += ' ' + line;
    }
  }
  if (current) results.push(current.trim());

  while (results.length < expected) {
    results.push(results[results.length - 1] || 'No summary available.');
  }
  return results;
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

  return provider.generate(prompt, generateModel, {});
}
