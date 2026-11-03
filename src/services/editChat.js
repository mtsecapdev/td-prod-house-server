import config from '../config.js';
import { chatStructured, requestEmbedding } from './llm.js';
import { getSimilarChunksDb } from '../db/chunksQueries.js';
import { getGenerationByIdDb, updateGenerationDb } from '../db/generationsQueries.js';

const slidePatchSchema = {
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

export async function editSlide(generationId, slideIndex, instruction, history = []) {
  const generation = await getGenerationByIdDb(generationId);
  const { outline, source_document_ids: docIds } = generation;

  const slide = outline.slides?.[slideIndex];
  if (!slide?.content) throw new Error(`Slide ${slideIndex} has no generated content`);

  const instructionEmbedding = await requestEmbedding(instruction);
  const chunks = await getSimilarChunksDb(instructionEmbedding, 3, docIds);

  const context = chunks
    .map((c, i) => `[${i + 1}] (page ${c.page ?? '?'}): ${c.content}`)
    .join('\n\n');

  const currentSlide = JSON.stringify(slide.content, null, 2);

  const messages = [
    {
      role: 'system',
      content:
        `You are editing a single training slide based on a user instruction.\n` +
        `Return the complete updated slide (title, bullets, speaker_notes) — not a diff.\n` +
        `If the instruction references source material, use the provided excerpts.\n` +
        `Keep changes minimal and focused on what the user asked for.\n\n` +
        `Current slide:\n${currentSlide}\n\n` +
        `Available source material:\n${context}`,
    },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: instruction },
  ];

  const updatedContent = await chatStructured(messages, config.ollama.generateModel, slidePatchSchema);

  const updatedSlides = [...outline.slides];
  updatedSlides[slideIndex] = {
    ...slide,
    content: { ...updatedContent, source_chunk_ids: slide.content.source_chunk_ids },
  };

  const editEntry = {
    slide_index: slideIndex,
    instruction,
    timestamp: new Date().toISOString(),
  };

  const editHistory = [...(generation.edit_history || []), editEntry];

  await updateGenerationDb(generationId, {
    outline: JSON.stringify({ ...outline, slides: updatedSlides }),
    edit_history: editHistory,
  });

  return updatedContent;
}
