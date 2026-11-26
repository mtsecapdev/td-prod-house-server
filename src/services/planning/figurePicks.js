// Puts the documents' figures on the slides/sections they illustrate, after the plan is made.
//
// Each item's candidates are the figures printed on or next to the pages its facts come from: a figure there
// is what the passage was explaining. One model call then sees every item with its few candidates (caption and
// the words printed in the figure) and picks, per item, the figure that shows what it explains; each figure goes
// on one item (shared, one figure ended up on five sections of a document). Left to the
// planner as one optional field among many, figures were skipped: a deck on the four-stroke cycle got none of
// the manual's stroke diagrams.
import config from '../../config.js';
import { generateStructured } from '../llm.js';
import { listFiguresDb } from '../../db/figuresQueries.js';

const { generateModel } = config.ollama;
// How far from an item's pages a figure may be printed and still be about it.
const PAGE_DISTANCE = 1;
const MAX_CANDIDATES = 5;
const LABEL_CHARS = 200;

/** The figures near an item's facts, nearest first: [{ figure, distance }]. */
function candidatesFor(item, figuresByDoc) {
  const near = new Map();
  for (const fact of item.facts || []) {
    if (fact.page == null) continue;
    for (const f of figuresByDoc.get(fact.document_id) || []) {
      if (f.page == null) continue;
      const distance = Math.abs(f.page - fact.page);
      if (distance <= PAGE_DISTANCE && (!near.has(f.id) || near.get(f.id).distance > distance)) near.set(f.id, { figure: f, distance });
    }
  }
  return [...near.values()].sort((a, b) => a.distance - b.distance || a.figure.page - b.figure.page).slice(0, MAX_CANDIDATES);
}

/**
 * Sets figure_id on the items a figure illustrates (kinds that show a picture beside their text), each figure on
 * one item at most. Items keep a figure they already have; `used`: figures already on other items. Returns the
 * items.
 */
export async function pickFigures(kind, items, documentIds, { used = [] } = {}) {
  if (!documentIds?.length) return items;
  const figures = await listFiguresDb({ documentIds });
  if (!figures.length) return items;
  const figuresByDoc = new Map();
  for (const f of figures) {
    if (!figuresByDoc.has(f.document_id)) figuresByDoc.set(f.document_id, []);
    figuresByDoc.get(f.document_id).push(f);
  }
  const taken = new Set([...used, ...items.map((it) => it.figure_id).filter(Boolean)]);
  const open = items
    .map((it, i) => ({ it, i, candidates: candidatesFor(it, figuresByDoc).filter((c) => !taken.has(c.figure.id)) }))
    .filter(({ it, candidates }) => !it.figure_id && kind.pictureTypes.includes(it[kind.typeKey]) && candidates.length);
  if (!open.length) return items;

  const prompt =
    `A ${kind.product} is being planned. Below are some of its ${kind.nounPlural}, each with the figures printed ` +
    `near the pages it draws on. For each ${kind.noun}, pick the figure that shows what it explains, so the reader ` +
    `can look at it while reading the ${kind.noun}: the thing, part, process or stage it is about. Include a ` +
    `figure whenever one fits: pictures make the ${kind.nounPlural} easier to follow. Pick 0 only when none of ` +
    `its figures shows its subject (one about a different part or process). Each figure goes on one ${kind.noun} ` +
    `at most: give it to the ${kind.noun} it fits best.\n\n` +
    open.map(({ it, i, candidates }) =>
      `${kind.noun[0].toUpperCase() + kind.noun.slice(1)} ${i + 1}: ${it.title}\n` +
      (it.bullets || []).map((b) => `  - ${b}`).join('\n') + '\n' +
      `  Figures near it:\n` +
      candidates.map(({ figure: f }) => `    ${f.id}: ${f.caption || '(no caption)'}` +
        (f.labels ? ` (text in it: ${String(f.labels).slice(0, LABEL_CHARS)})` : '')).join('\n')).join('\n\n');
  const schema = {
    type: 'object',
    properties: {
      picks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            item: { type: 'integer', enum: open.map(({ i }) => i + 1) },
            figure: { type: 'integer', enum: [0, ...new Set(open.flatMap(({ candidates }) => candidates.map((c) => c.figure.id)))] },
          },
          required: ['item', 'figure'],
        },
      },
    },
    required: ['picks'],
  };
  let picks = [];
  try {
    ({ picks = [] } = await generateStructured(prompt, generateModel, schema, { think: true }));
  } catch (err) {
    console.warn(`Figure picking skipped: ${err.message}`);
    return items;
  }

  const allowed = new Map(open.map(({ i, candidates }) => [i, new Set(candidates.map((c) => c.figure.id))]));
  for (const { item, figure } of picks) {
    const i = item - 1;
    if (!figure || !allowed.get(i)?.has(figure) || taken.has(figure) || items[i].figure_id) continue;
    items[i] = { ...items[i], figure_id: figure };
    taken.add(figure);
  }
  return items;
}
