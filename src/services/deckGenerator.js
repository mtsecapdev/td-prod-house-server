import config from '../config.js';
import { generateStructured, chatStructured, requestEmbedding } from './llm.js';
import { getSimilarChunksDb } from '../db/chunksQueries.js';
import { updateGenerationDb } from '../db/generationsQueries.js';

const SLIDE_COUNTS = { quick: [3, 5], standard: [6, 10], deep: [12, 18] };

const outlineSchema = {
  type: 'object',
  properties: {
    slides: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          intent: { type: 'string' },
        },
        required: ['title', 'intent'],
      },
    },
  },
  required: ['slides'],
};

const slideSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    bullets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          heading: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['heading', 'detail'],
      },
    },
    speaker_notes: { type: 'string' },
  },
  required: ['title', 'bullets', 'speaker_notes'],
};

export async function generateOutline(generation) {
  const { brief, source_document_ids: docIds } = generation;
  const { topic, audience, length } = brief;
  const [min, max] = SLIDE_COUNTS[length] || SLIDE_COUNTS.standard;

  const topicEmbedding = await requestEmbedding(topic);
  const topicChunks = await getSimilarChunksDb(topicEmbedding, 10, docIds);

  const context = topicChunks
    .map((c, i) => `[${i + 1}] (page ${c.page ?? '?'}): ${c.content}`)
    .join('\n\n');

  const prompt =
    `You are an instructional designer creating a training slide deck.\n\n` +
    `Topic: ${topic}\nAudience: ${audience}\nSlide count: ${min}–${max} slides\n\n` +
    `Source material:\n${context}\n\n` +
    `Generate an outline: for each slide, provide a clear title and a one-sentence intent ` +
    `describing what the audience should learn from that slide. ` +
    `Use only information from the source material. Stay within the slide count range.`;

  const result = await generateStructured(prompt, config.ollama.generateModel, outlineSchema);

  const slides = result.slides.map((s, i) => ({
    index: i,
    title: s.title,
    intent: s.intent,
    source_chunks: topicChunks.slice(0, 3).map((c) => ({
      chunk_id: c.id,
      page: c.page,
      preview: c.content.slice(0, 120),
    })),
  }));

  return { slides };
}

export async function generateSlideContent(generation, slideIndex) {
  const { outline, source_document_ids: docIds } = generation;
  const slide = outline.slides[slideIndex];
  if (!slide) throw new Error(`Slide ${slideIndex} not in outline`);

  const slideEmbedding = await requestEmbedding(slide.title + ' ' + slide.intent);
  const chunks = await getSimilarChunksDb(slideEmbedding, 5, docIds);

  const context = chunks
    .map((c, i) => `[${i + 1}] (page ${c.page ?? '?'}): ${c.content}`)
    .join('\n\n');

  const messages = [
    {
      role: 'system',
      content:
        `You are an instructional designer filling in a training slide.\n` +
        `Write concise, actionable bullet points suitable for a presentation.\n` +
        `Each bullet has a short heading and a one-sentence detail.\n` +
        `Write speaker notes that expand on the bullets for the presenter.\n` +
        `Use only the source material provided.`,
    },
    {
      role: 'user',
      content:
        `Slide title: ${slide.title}\nIntent: ${slide.intent}\n\n` +
        `Source material:\n${context}\n\n` +
        `Generate 3–5 bullets with headings and detail, plus speaker notes.`,
    },
  ];

  const result = await chatStructured(messages, config.ollama.generateModel, slideSchema);

  return {
    ...result,
    source_chunk_ids: chunks.map((c) => c.id),
  };
}

export async function generateAllSlides(generation, onProgress) {
  const { outline } = generation;
  const slides = [];

  for (let i = 0; i < outline.slides.length; i++) {
    if (onProgress) onProgress({ slide: i + 1, total: outline.slides.length, phase: 'slide' });
    const content = await generateSlideContent(generation, i);
    slides.push({ ...outline.slides[i], content });
  }

  return slides;
}
