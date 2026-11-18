// Deck-wide agent (Gamma-style): the user asks for a change across the whole deck or document; the model
// proposes a list of item-level steps, the user reviews them, and applying runs them one by one. Steps refer
// to items by id, so earlier steps (adds, deletes, moves) never make later ones hit the wrong item. The
// outline before applying is kept so the whole change can be undone.
import { randomBytes } from 'node:crypto';
import config from '../../config.js';
import { generateStructured } from '../llm.js';
import { getGenerationByIdDb, updateGenerationDb, heartbeatJobDb } from '../../db/generationsQueries.js';
import { kindOf, briefBlock } from './kinds.js';
import { rewriteItem, editItem, insertItem, deleteItem, moveItem } from './itemOps.js';

const MAX_STEPS = 20;
const ACTIONS = ['edit', 'layout', 'add', 'delete', 'move'];

function textOf(content) {
  if (!content) return '(not written)';
  const { source_chunk_ids: _a, used_pages: _b, diagram_file: _c, mermaid_code: _d, speaker_notes: _e, image: _f, pictures: _g, ...rest } = content;
  return JSON.stringify(rest).replace(/[{}"[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** Gives every item an id (older generations have none) and saves them. */
async function ensureIds(generation, kind) {
  const items = generation.outline?.[kind.listKey] || [];
  if (items.every((it) => it.id)) return generation;
  const withIds = items.map((it) => (it.id ? it : { ...it, id: kind.idPrefix + randomBytes(4).toString('hex') }));
  const outline = { ...generation.outline, [kind.listKey]: withIds };
  await updateGenerationDb(generation.id, { outline: JSON.stringify(outline) });
  return { ...generation, outline };
}

/** Proposes the steps that carry out `instruction` across the deck. Nothing is changed yet. */
export async function planAgent(generationInput, instruction) {
  const kind = kindOf(generationInput);
  const generation = await ensureIds(generationInput, kind);
  const items = generation.outline[kind.listKey];

  const prompt =
    `You are editing a ${kind.product} for a user. Decide the smallest set of steps that does what they ask.\n\n` +
    `${briefBlock(generation)}\n\n` +
    `The ${kind.nounPlural}, in order (id | type | title | content):\n` +
    items.map((it, i) => `${i + 1}. ${it.id} | ${it[kind.typeKey]} | ${it.title} | ${textOf(it.content)}`).join('\n') +
    `\n\nThe user asks: "${instruction}"\n\n` +
    `Step actions:\n` +
    `- "edit": change one ${kind.noun}'s text. instruction says exactly what to change, self-contained.\n` +
    `- "layout": rewrite one ${kind.noun} in another layout (set layout). Use only when the user asks for a different presentation.\n` +
    `- "add": a new ${kind.noun} after item_id (or item_id "start" for first). instruction describes it.\n` +
    `- "delete": remove item_id.\n` +
    `- "move": move item_id to position (1-based).\n` +
    `Rules: touch only ${kind.nounPlural} the request concerns. For a deck-wide change (tone, language, length), ` +
    `one "edit" per affected ${kind.noun}. At most ${MAX_STEPS} steps. Use "" for fields an action does not use, 0 for position.\n` +
    `summary: one sentence telling the user what will change.`;

  const schema = {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      steps: {
        type: 'array',
        maxItems: MAX_STEPS,
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ACTIONS },
            item_id: { type: 'string' },
            instruction: { type: 'string' },
            layout: { type: 'string', enum: ['', ...kind.types] },
            position: { type: 'integer' },
          },
          required: ['action', 'item_id', 'instruction', 'layout', 'position'],
        },
      },
    },
    required: ['summary', 'steps'],
  };
  const result = await generateStructured(prompt, config.ollama.generateModel, schema, { think: true });

  const ids = new Set(items.map((it) => it.id));
  const titleOf = Object.fromEntries(items.map((it, i) => [it.id, `${i + 1}. ${it.title}`]));
  const steps = (result.steps || [])
    .filter((s) => ACTIONS.includes(s.action) && (ids.has(s.item_id) || (s.action === 'add' && s.item_id === 'start')))
    .filter((s) => s.action !== 'layout' || kind.types.includes(s.layout))
    .map((s) => ({
      ...s,
      // An edit/add without its own instruction carries the user's request, applied to that item.
      instruction: s.instruction?.trim() || (['edit', 'add'].includes(s.action) ? `Apply this request to this ${kind.noun}: ${instruction}` : ''),
      target: s.item_id === 'start' ? 'the start' : titleOf[s.item_id],
    }));
  return { summary: result.summary, steps };
}

/** Runs reviewed steps in order. Saves the outline first so applyUndo can restore it. */
export async function applyAgent(generationId, steps) {
  const before = await getGenerationByIdDb(generationId);
  const kind = kindOf(before);
  await updateGenerationDb(generationId, {
    settings: JSON.stringify({ ...(before.settings || {}), agent_undo: { outline: before.outline, at: new Date().toISOString() } }),
  });

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    await heartbeatJobDb(generationId, { done: i, total: steps.length, title: `${step.action} ${step.target || ''}`.trim() });
    const current = await getGenerationByIdDb(generationId);
    const items = current.outline?.[kind.listKey] || [];
    const index = items.findIndex((it) => it.id === step.item_id);
    if (index === -1 && !(step.action === 'add' && step.item_id === 'start')) continue; // deleted by an earlier step

    if (step.action === 'edit') await editItem(generationId, index, step.instruction);
    else if (step.action === 'layout') await rewriteItem(generationId, index, { type: step.layout });
    else if (step.action === 'add') await insertItem(generationId, step.item_id === 'start' ? -1 : index, step.instruction);
    else if (step.action === 'delete') await deleteItem(generationId, index);
    else if (step.action === 'move') await moveItem(generationId, index, Number(step.position) - 1);
  }
}

/** Restores the outline from before the last applied agent change. */
export async function undoAgent(generationId) {
  const generation = await getGenerationByIdDb(generationId);
  const snapshot = generation.settings?.agent_undo;
  if (!snapshot) throw new Error('Nothing to undo');
  const { agent_undo: _drop, ...settings } = generation.settings;
  await updateGenerationDb(generationId, { outline: JSON.stringify(snapshot.outline), settings: JSON.stringify(settings) });
}
