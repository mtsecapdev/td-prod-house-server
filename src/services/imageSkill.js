// The image skill: an image made from what the conversation is about (or for one slide/section), generated in
// the background. With a target it is placed on that slide/section when done.
import config from '../config.js';
import { generateStructured } from './llm.js';
import { transcript } from './skills.js';
import { craftImagePrompt, generateImageFromPrompt } from './imageGenerator.js';
import { startJob } from './jobs.js';
import { addPicture } from './planning/itemOps.js';
import { kindOf } from './planning/kinds.js';
import { getGenerationByIdDb, insertGenerationDb, updateGenerationDb } from '../db/generationsQueries.js';

const STYLES = ['photorealistic', 'illustration', 'technical drawing', 'conceptual'];
const SIZES = ['landscape', 'square', 'portrait'];
const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string' },
    style: { type: 'string', enum: STYLES },
    size: { type: 'string', enum: SIZES },
    caption: { type: 'string' },
  },
  required: ['subject', 'style', 'size', 'caption'],
};

const NOT_SAID = new Set(['speaker_notes', 'notes', 'mermaid_code', 'diagram_file', 'diagram_type', 'pictures', 'image', 'icon', 'source_chunk_ids', 'used_pages']);

/** What a slide/section says (every text on it, whatever its kind), for an image made for it. */
function itemText(item) {
  const parts = [item?.content?.title ? '' : item?.title];
  (function walk(v, key) {
    if (NOT_SAID.has(key)) return;
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, k));
  })(item?.content || {});
  return parts.filter((p) => typeof p === 'string' && p.trim()).join('\n');
}

/**
 * The image brief: what it shows, style, shape, and a caption for when it sits on a slide.
 * target: { generation, index } when the image is for one slide/section.
 */
export async function imageBrief(messages, request, target) {
  const history = transcript(messages);
  const item = target ? target.generation.outline?.[kindOf(target.generation).listKey]?.[target.index] : null;
  const prompt =
    `A user working with their documents wants an image.\n\n` +
    (history ? `The conversation:\n"""\n${history}\n"""\n\n` : '') +
    (item ? `It is for this ${kindOf(target.generation).noun}:\n"""\n${itemText(item)}\n"""\n\n` : '') +
    `What they asked for: ${request || '(an image for what is being discussed)'}\n\n` +
    `Answer as JSON:\n` +
    `subject: What should the image show? A concrete visual description of the scene or object (no text in the image).\n` +
    `style: Which style suits it, or which did they ask for?\n` +
    `size: landscape for slides and most scenes, portrait or square only if asked or clearly better.\n` +
    `caption: A short caption for the image (a few words).`;
  const brief = await generateStructured(prompt, config.ollama.generateModel, BRIEF_SCHEMA, { think: false });
  return {
    topic: brief.subject.trim() || request,
    style: brief.style,
    size: item ? 'landscape' : brief.size,
    caption: brief.caption.trim(),
  };
}

/** Creates the image and starts generating it. target: { generation, index } to place it on a slide/section. */
export async function startImage({ brief, conversationId, documentIds = [], target = null, ownerId }) {
  const id = await insertGenerationDb({
    ownerId,
    type: 'image',
    brief: JSON.stringify({ ...brief, ...(target ? { target: { generation_id: target.generation.id, index: target.index } } : {}) }),
    sourceDocumentIds: documentIds,
    conversationId,
  });
  await updateGenerationDb(id, { status: 'generating' });
  await runImageJob(id);
  return getGenerationByIdDb(id);
}

/** Writes the image prompt, generates the image, and places it when it was made for a slide. */
export async function runImageJob(id) {
  return startJob(id, 'image', async () => {
    const promptData = await craftImagePrompt(await getGenerationByIdDb(id));
    await updateGenerationDb(id, { outline: JSON.stringify(promptData) });
    const generation = await getGenerationByIdDb(id);
    const result = await generateImageFromPrompt(generation, () => {});
    const target = generation.brief?.target;
    if (target) await addPicture(target.generation_id, target.index, { image_id: id, caption: generation.brief.caption || '' });
    return { outline: JSON.stringify({ ...result, caption: generation.brief.caption }), status: 'done' };
  });
}
