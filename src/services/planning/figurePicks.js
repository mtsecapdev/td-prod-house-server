// Puts the documents' figures on the slides/sections they illustrate, after the plan is made.
//
// Each item's candidates are the figures printed on or next to the pages its facts come from: a figure there
// is what the passage was explaining. One model call then sees every item with its few candidates (caption, what
// the picture shows as described after import, and the words printed in it) and picks, per item, the figure
// that shows what it explains; each figure goes
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
 * Sets figure_ids on the items figures illustrate (kinds that show a picture beside their text): up to
 * kind.figuresPerItem each (a slide's panel holds one; a section can show two), each figure on one item at
 * most. Items keep figures they already have; `used`: figures already on other items. Returns the items.
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
  const per = kind.figuresPerItem;
  const taken = new Set([...used, ...items.flatMap((it) => it.figure_ids || [])]);
  const open = items
    .map((it, i) => ({ it, i, candidates: candidatesFor(it, figuresByDoc).filter((c) => !taken.has(c.figure.id)) }))
    .filter(({ it, candidates }) => !it.figure_ids?.length && kind.pictureTypes.includes(it[kind.typeKey]) && candidates.length);
  if (!open.length) return items;

  const prompt =
    `A ${kind.product} is being planned. Below are some of its ${kind.nounPlural}, each with the figures printed ` +
    `near the pages it draws on. For each ${kind.noun}, pick ${per > 1 ? `up to ${per} figures that show` : 'the figure that shows'} ` +
    `what it explains, so the reader can look at ${per > 1 ? 'them' : 'it'} while reading the ${kind.noun}: the ` +
    `thing, part, process or stage it is about. Judge a figure by what the picture shows: its description when ` +
    `there is one (written by someone who looked at it), else the words printed in it. A caption can promise ` +
    `more than the picture shows. Include a figure whenever one fits: pictures make the ` +
    `${kind.nounPlural} easier to follow.` +
    (per > 1 ? ` Add a second figure only when it shows something the first does not (another part, stage or type the ${kind.noun} explains).` : '') +
    ` Pick none when no figure shows its subject (one about a different part or process). Each figure goes on ` +
    `one ${kind.noun} at most: give it to the ${kind.noun} it fits best.\n\n` +
    open.map(({ it, i, candidates }) =>
      `${kind.noun[0].toUpperCase() + kind.noun.slice(1)} ${i + 1}: ${it.title}\n` +
      (it.bullets || []).map((b) => `  - ${b}`).join('\n') + '\n' +
      `  Figures near it:\n` +
      candidates.map(({ figure: f }) => `    ${f.id}: ${f.caption || '(no caption)'}` +
        (f.description ? `\n      Shows: ${f.description}` : '') +
        (f.labels ? `\n      Text in it: ${String(f.labels).slice(0, LABEL_CHARS)}` : '')).join('\n')).join('\n\n');
  const schema = {
    type: 'object',
    properties: {
      picks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            item: { type: 'integer', enum: open.map(({ i }) => i + 1) },
            figures: {
              type: 'array', maxItems: per,
              items: { type: 'integer', enum: [...new Set(open.flatMap(({ candidates }) => candidates.map((c) => c.figure.id)))] },
            },
          },
          required: ['item', 'figures'],
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
  for (const { item, figures: chosen = [] } of picks) {
    const i = item - 1;
    if (items[i]?.figure_ids?.length) continue;
    const ids = [...new Set(chosen)].filter((id) => allowed.get(i)?.has(id) && !taken.has(id)).slice(0, per);
    if (!ids.length) continue;
    items[i] = { ...items[i], figure_ids: ids };
    ids.forEach((id) => taken.add(id));
  }
  return items;
}
