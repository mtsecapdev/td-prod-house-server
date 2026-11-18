// Operations on one slide/section of a written deck or document, saved straight to the generation. Used by
// the per-item Edit with AI endpoints and by the deck-wide agent.
import { getGenerationByIdDb, updateGenerationDb } from '../../db/generationsQueries.js';
import { editSlide, editSection } from '../editChat.js';
import { kindOf } from './kinds.js';
import { planOneItem } from './planner.js';
import { writeItem } from './writer.js';
import { randomBytes } from 'node:crypto';
import { getFigureByIdDb } from '../../db/figuresQueries.js';
import { getChunksWithFigureDb } from '../../db/chunksQueries.js';
import { stripFigureMarkers } from '../figures.js';

function indexKey(kind) {
  return kind.name === 'deck' ? 'slide_index' : 'section_index';
}

/** Rewrites one item from its plan, optionally with a note or a different layout. Returns the saved item. */
export async function rewriteItem(generationId, index, { note, type: requestedType } = {}) {
  const generation = await getGenerationByIdDb(generationId);
  const kind = kindOf(generation);
  const item = generation.outline?.[kind.listKey]?.[index];
  if (!item) throw new Error(`${kind.noun} ${index + 1} not found`);

  const { type, content, sources } = await writeItem(generation, index, { note, type: requestedType });

  const latest = await getGenerationByIdDb(generationId);
  const items = [...latest.outline[kind.listKey]];
  items[index] = { ...items[index], [kind.typeKey]: type, content, sources, ...(note !== undefined ? { note } : {}) };
  await updateGenerationDb(generationId, {
    outline: JSON.stringify({ ...latest.outline, [kind.listKey]: items }),
    edit_history: [...(latest.edit_history || []), {
      [indexKey(kind)]: index,
      instruction: requestedType ? `Change layout to ${type}` : note ? `Regenerate: ${note}` : 'Regenerate',
      before: item.content,
      timestamp: new Date().toISOString(),
    }],
  });
  return items[index];
}

/**
 * Applies a written instruction to one item's content (same as the per-item chat). An item that has not been
 * written yet is written with the instruction as its note instead.
 */
export async function editItem(generationId, index, instruction) {
  const generation = await getGenerationByIdDb(generationId);
  const kind = kindOf(generation);
  if (!generation.outline?.[kind.listKey]?.[index]?.content) return rewriteItem(generationId, index, { note: instruction });
  const edit = kind.name === 'deck' ? editSlide : editSection;
  return edit(generationId, index, instruction, []);
}

/** Plans and writes a new item from a description and inserts it after `after` (-1 = first). */
export async function insertItem(generationId, after, description) {
  const generation = await getGenerationByIdDb(generationId);
  const kind = kindOf(generation);
  const items = generation.outline?.[kind.listKey] || [];
  const at = Math.min(Math.max(Number(after), -1), items.length - 1) + 1;

  const item = await planOneItem(generation, description, at - 1);
  const withNew = [...items];
  withNew.splice(at, 0, item);
  const written = await writeItem({ ...generation, outline: { ...generation.outline, [kind.listKey]: withNew } }, at);
  const saved = { ...item, [kind.typeKey]: written.type, content: written.content, sources: written.sources };

  const latest = await getGenerationByIdDb(generationId);
  const latestItems = [...(latest.outline?.[kind.listKey] || [])];
  latestItems.splice(at, 0, saved);
  await updateGenerationDb(generationId, { outline: JSON.stringify({ ...latest.outline, [kind.listKey]: latestItems }) });
  return { index: at, item: saved };
}

export async function deleteItem(generationId, index) {
  const generation = await getGenerationByIdDb(generationId);
  const kind = kindOf(generation);
  const items = (generation.outline?.[kind.listKey] || []).filter((_, i) => i !== index);
  await updateGenerationDb(generationId, { outline: JSON.stringify({ ...generation.outline, [kind.listKey]: items }) });
}

export async function moveItem(generationId, index, toIndex) {
  const generation = await getGenerationByIdDb(generationId);
  const kind = kindOf(generation);
  const items = [...(generation.outline?.[kind.listKey] || [])];
  const [item] = items.splice(index, 1);
  if (!item) return;
  items.splice(Math.min(Math.max(toIndex, 0), items.length), 0, item);
  await updateGenerationDb(generationId, { outline: JSON.stringify({ ...generation.outline, [kind.listKey]: items }) });
}

/**
 * Puts a figure from the documents into the deck/document as a new Figure item after `index`, written from the
 * passages around it. (Pictures on existing items are placed by the editor itself.) Returns the new item's index.
 */
export async function placeFigure(generationId, figureId, index) {
  const generation = await getGenerationByIdDb(generationId);
  const kind = kindOf(generation);
  const figure = await getFigureByIdDb(figureId);
  if (!figure) throw new Error('That figure no longer exists');

  const passages = await getChunksWithFigureDb(figure.document_id, figure.key);
  const item = {
    id: kind.idPrefix + randomBytes(4).toString('hex'),
    title: figure.caption.replace(/^fig(ure)?\.?\s*[A-Z]?\d+(?:[.-]\d+)*[a-z]?\s*/i, '') || 'Figure',
    bullets: [],
    [kind.typeKey]: 'figure',
    type_reason: 'Figure from the document',
    figure_id: figure.id,
    sources: passages.map((p) => ({
      chunk_id: p.id, page: p.page, heading: p.heading,
      preview: stripFigureMarkers(p.content).replace(/\s+/g, ' ').trim().slice(0, 220), added: true,
    })),
    content: null,
  };

  const items = [...(generation.outline?.[kind.listKey] || [])];
  const at = Math.min(index + 1, items.length);
  items.splice(at, 0, item);
  const planned = { ...generation, outline: { ...generation.outline, [kind.listKey]: items } };
  const written = await writeItem(planned, at);

  const latest = await getGenerationByIdDb(generationId);
  const latestItems = [...(latest.outline?.[kind.listKey] || [])];
  const saved = { ...item, [kind.typeKey]: written.type, content: written.content };
  latestItems.splice(at, 0, saved);
  await updateGenerationDb(generationId, { outline: JSON.stringify({ ...latest.outline, [kind.listKey]: latestItems }) });
  return { index: at, item: saved };
}
