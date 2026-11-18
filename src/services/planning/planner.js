// Planning for decks and documents: turns the user's request into an outline of N items (title + bullets +
// layout), each tied to the passages it draws on.
//
// It plans the way the document chat answers: from the documents' actual passages (exact figures included),
// not from section summaries. Figures in the outline are allowed only when they appear in those passages, and
// each item keeps the ids of the passages it used; they become its sources, so planning and writing work from
// the same evidence. Content is planned first, as the chat would outline it; layouts are chosen in a second,
// quick step, so layout rules never compete with what the slides say.
import { randomBytes } from 'node:crypto';
import config from '../../config.js';
import { generateStructured, requestEmbedding, requestEmbeddingBatch } from '../llm.js';
import { getDocumentMapDb, getSourcePassagesDb } from '../../db/chunksQueries.js';
import { kindOf, briefBlock, storylineBlock, itemCount } from './kinds.js';
import { chooseLayouts, finishLayouts } from './layouts.js';
import { stripFigureMarkers, figureNumber } from '../figures.js';
import { listFiguresDb } from '../../db/figuresQueries.js';

const { generateModel } = config.ollama;
const PREVIEW_CHARS = 220;
// Passages read when planning: enough to cover a typical report the way chat does (~8-10k tokens).
const PLAN_PASSAGES = 24;
const ADD_ITEM_PASSAGES = 6;
// Pasted text is read in full when planning; very long pastes are cut to stay inside the model's context.
const MAX_PASTED_CHARS = 20000;
// Slides marked by the user: a line containing only "---".
const SPLIT_RE = /\n\s*-{3,}\s*\n/;

function newItemId(kind) {
  return kind.idPrefix + randomBytes(4).toString('hex');
}

export function pastedText(brief) {
  return (brief?.source_text || '').trim().slice(0, MAX_PASTED_CHARS);
}

function passageBlock(rows) {
  return rows.map((r) => `[${r.id}] p.${r.page ?? '?'}${r.heading ? ` · ${r.heading}` : ''}\n${stripFigureMarkers(r.content).trim()}`).join('\n\n');
}

// What to plan from: the passages most relevant to the request (plus the documents' section list, so the
// plan knows what else exists), or the user's own text.
async function planningMaterial(generation) {
  const pasted = pastedText(generation.brief);
  if (pasted) return { block: `The user's own text, to build from:\n"""\n${pasted}\n"""`, passages: [] };

  const query = [generation.brief?.topic, generation.brief?.instructions].filter(Boolean).join('\n');
  const embedding = await requestEmbedding(query);
  const [passages, map] = await Promise.all([
    getSourcePassagesDb(embedding, PLAN_PASSAGES, generation.source_document_ids, query),
    getDocumentMapDb(generation.source_document_ids, { topicEmbedding: embedding }),
  ]);
  const ordered = [...passages].sort((a, b) => a.document_id - b.document_id || a.id - b.id); // reading order
  const sections = map.sections.map((s) => `- ${s.heading}${s.page != null ? ` (p. ${s.page})` : ''}`).join('\n');
  return {
    block: `Sections of the documents:\n${sections}\n\nPassages (id, page, section):\n${passageBlock(ordered)}`,
    passages: ordered,
  };
}

// ── 1. Content ──

function contentSchema(count) {
  return {
    type: 'object',
    properties: {
      audience: { type: 'string' },
      tone: { type: 'string' },
      thesis: { type: 'string' },
      items: {
        type: 'array',
        minItems: count,
        maxItems: count,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            bullets: { type: 'array', maxItems: 6, items: { type: 'string' } },
            source_ids: { type: 'array', items: { type: 'integer' } },
          },
          required: ['title', 'bullets', 'source_ids'],
        },
      },
    },
    required: ['audience', 'tone', 'thesis', 'items'],
  };
}

async function planContent(generation, kind, material, count) {
  const opening = kind.name === 'deck' ? 'a title slide saying what the deck covers' : 'a title page with the document\'s purpose';
  const closing = kind.name === 'deck' ? 'the takeaways and what to do next' : 'a summary and next steps';
  const prompt =
    `You are outlining a ${kind.product} of exactly ${count} ${kind.nounPlural} for the user below, the way an ` +
    `expert would outline it before writing.\n\n${briefBlock(generation)}\n\n${material.block}\n\n` +
    `For each ${kind.noun}:\n` +
    `- title: specific to its content (max 10 words), never generic ("Introduction", "Key points").\n` +
    `- bullets: 3-6 concrete points it will present: facts, figures, names, examples. Use exact figures from the ` +
    `material where they help the point; never state a figure that is not in the material.\n` +
    `- source_ids: the ids of the passages its bullets draw on (empty when it draws on none).\n\n` +
    `Rules:\n` +
    `- Exactly ${count} ${kind.nounPlural}. The first is ${opening}; the last is ${closing}.\n` +
    `- One main idea per ${kind.noun}; no two cover the same ground. Cover everything the user asked for.\n` +
    `- Order them so the ${kind.product} builds an argument from situation to conclusion.\n` +
    `Also return: audience (who it is for, a few words; the user's if given), tone (2-4 adjectives), and thesis ` +
    `(the one sentence the ${kind.name === 'deck' ? 'audience' : 'reader'} should leave with).`;
  return generateStructured(prompt, generateModel, contentSchema(count), { think: true });
}

// ── The whole plan ──

/** Builds the outline: content from the material, then layouts, then sources per item. */
export async function planOutline(generation) {
  const kind = kindOf(generation);
  const pasted = pastedText(generation.brief);
  if (pasted && SPLIT_RE.test(`\n${pasted}\n`)) return planFromSegments(generation, kind, pasted);

  const count = itemCount(kind, generation.brief);
  const material = await planningMaterial(generation);
  const plan = await planContent(generation, kind, material, count);

  const byId = new Map(material.passages.map((p) => [p.id, p]));
  let items = (plan.items || []).filter((raw) => raw.title).map((raw) => ({
    id: newItemId(kind),
    title: raw.title,
    bullets: (raw.bullets || []).map((b) => b.trim()).filter(Boolean),
    // The passages this item was planned from become its sources.
    sources: [...new Set(raw.source_ids || [])].filter((id) => byId.has(id))
      .slice(0, kind.sourcesPerItem + 2).map((id) => toSource(byId.get(id))),
    content: null,
  }));
  items = finishLayouts(kind, generation.brief, await chooseLayouts(generation, kind, items));
  if (generation.source_document_ids?.length) items = await suggestFigures(kind, items, generation.source_document_ids);
  // Items the plan gave no passages (and that need evidence) get sources by search.
  await attachSources(generation, kind, items.filter((it) => !it.sources.length));

  return {
    storyline: { audience: plan.audience, tone: plan.tone, thesis: plan.thesis, generated_at: new Date().toISOString() },
    outline: { [kind.listKey]: items, generated_at: new Date().toISOString() },
  };
}

// ── Figures from the documents ──

const MAX_SUGGESTED_FIGURES = 2;
const STOPWORDS = new Set('with from that this their which about into over under between overall other these those there where when what'.split(' '));

function keywords(text) {
  return new Set((String(text).toLowerCase().match(/[a-z][a-z0-9&-]{3,}/g) || []).filter((w) => !STOPWORDS.has(w)));
}

// Layouts that carry content a figure can't replace: numbers, quotes, a single statement, bookends.
const KEEP_TYPES = new Set(['key_stats', 'stat_focus', 'quote_highlight', 'big_idea', 'section_divider', 'key_points']);
const FIGURE_PAGE_DISTANCE = 3;

const FIGURE_CANDIDATES_PER_ITEM = 3;
const MIN_CANDIDATE_OVERLAP = 0.25;

/**
 * Turns slides into Figure slides when a figure in their documents shows what they are about.
 * 1. Candidates by cheap matching: figures the slide names ("Figure 2.0-1"), or whose caption shares key words
 *    with the slide and that sit within a few pages of its sources. (A figure's marker is in one passage only,
 *    so requiring it in the slide's own sources missed figures on the next page.)
 * 2. One quick model call decides, per slide, which candidate shows its subject, or none. Word matching alone
 *    missed abbreviations ("SE Engine" vs "Systems Engineering Engine") and matched recap slides that merely
 *    repeat a caption's words.
 * At most two per deck; each figure once; number, quote and statement slides are left alone.
 */
async function suggestFigures(kind, items, documentIds) {
  const figures = await listFiguresDb({ documentIds });
  if (!figures.length) return items;

  const candidates = new Map(); // item index -> figures
  items.forEach((it, i) => {
    if (i === 0 || i === items.length - 1 || KEEP_TYPES.has(it[kind.typeKey])) return;
    const text = `${it.title} ${(it.bullets || []).join(' ')}`;
    const words = keywords(text);
    const pages = (it.sources || []).map((s) => s.page).filter((p) => p != null);
    const scored = figures.map((f) => {
      const n = figureNumber(f.caption);
      const named = n && new RegExp(`\\bfig(?:ure)?\\.?\\s*${n.replace(/[.-]/g, '[.-]')}\\b`, 'i').test(text);
      const near = f.page != null && pages.some((p) => Math.abs(p - f.page) <= FIGURE_PAGE_DISTANCE);
      const captionWords = keywords(`${f.caption.replace(/^fig(ure)?\.?\s*[A-Z]?\d+(?:[.-]\d+)*[a-z]?\s*/i, '')} ${f.labels.slice(0, 300)}`);
      const overlap = captionWords.size ? [...captionWords].filter((w) => words.has(w)).length / captionWords.size : 0;
      return { f, score: named ? 1 : near ? overlap + 0.2 : 0 };
    }).filter((x) => x.score >= MIN_CANDIDATE_OVERLAP).sort((x, y) => y.score - x.score).slice(0, FIGURE_CANDIDATES_PER_ITEM);
    if (scored.length) candidates.set(i, scored.map((x) => x.f));
  });
  if (!candidates.size) return items;

  const prompt =
    `For each ${kind.noun} below, decide whether one of its candidate figures (from the source documents) shows ` +
    `what the ${kind.noun} is about, so the ${kind.noun} should present that figure.\n\n` +
    [...candidates.entries()].map(([i, figs]) =>
      `[S${i + 1}] ${items[i].title}\n${(items[i].bullets || []).map((b) => `  - ${b}`).join('\n')}\n` +
      `  Candidates:\n${figs.map((f) => `   [${f.id}] ${f.caption}. Text in it: ${f.labels.slice(0, 240)}`).join('\n')}`,
    ).join('\n\n') +
    `\n\nAnswer for each ${kind.noun} by its label (S2, S3...) with the id of the figure that shows its subject, or 0 for none. Choose a ` +
    `figure only when it is clearly about the same thing as the whole ${kind.noun}, not just related. Recaps, ` +
    `takeaways and next steps get 0.`;
  const schema = {
    type: 'object',
    properties: {
      choices: {
        type: 'array',
        items: {
          type: 'object',
          // Labels, not numbers: asked for numbers, the model counted its own answers from 0.
          properties: { slide: { type: 'string', enum: [...candidates.keys()].map((i) => `S${i + 1}`) }, figure_id: { type: 'integer' } },
          required: ['slide', 'figure_id'],
        },
      },
    },
    required: ['choices'],
  };
  const result = await generateStructured(prompt, generateModel, schema, { think: false });

  const usedFigures = new Set();
  let used = 0;
  for (const { slide, figure_id: figureId } of result.choices || []) {
    const i = Number(String(slide).slice(1)) - 1;
    const figure = candidates.get(i)?.find((f) => f.id === figureId);
    if (!figure || usedFigures.has(figure.id) || used >= MAX_SUGGESTED_FIGURES) continue;
    items[i] = { ...items[i], [kind.typeKey]: 'figure', figure_id: figure.id, type_reason: `Shows ${figure.caption}` };
    usedFigures.add(figure.id);
    used++;
  }
  return items;
}

// The user split their text into slides with "---": one item per part, in their order, each carrying its
// part as `own_text`. The model only titles, summarises and picks a layout for each part.
async function planFromSegments(generation, kind, pasted) {
  const parts = pasted.split(SPLIT_RE).map((p) => p.trim()).filter(Boolean).slice(0, kind.countRange[1]);
  const prompt =
    `The user wrote a ${kind.product} as ${parts.length} parts, one ${kind.noun} each, in this order.\n\n` +
    `${briefBlock(generation)}\n\n` +
    parts.map((p, i) => `--- Part ${i + 1} ---\n${p}`).join('\n\n') + '\n\n' +
    `Return audience (who it is for, a few words), tone (2-4 adjectives), thesis (one sentence) and exactly ` +
    `${parts.length} items, item i for part i:\n` +
    `- title: the part's own heading if it has one, otherwise a specific title (max 10 words).\n` +
    `- bullets: 2-5 short lines on what the part covers, taken from its text.\n- source_ids: [].`;
  const plan = await generateStructured(prompt, generateModel, contentSchema(parts.length), { think: false });

  let items = parts.map((part, i) => {
    const raw = plan.items?.[i] || { title: part.split('\n')[0].slice(0, 80), bullets: [] };
    return {
      id: newItemId(kind),
      title: raw.title,
      bullets: (raw.bullets || []).filter(Boolean),
      sources: [],
      content: null,
      own_text: part,
    };
  });
  items = await chooseLayouts(generation, kind, items);
  // Keep the user's structure: bookend layouts only where they fit, nothing else forced.
  items = items.map((it, i) => {
    const t = it[kind.typeKey];
    return (t === kind.firstType && i !== 0) || (t === kind.lastType && i !== items.length - 1)
      ? { ...it, [kind.typeKey]: kind.defaultType } : it;
  });
  await attachSources(generation, kind, items);
  return {
    storyline: { audience: plan.audience, tone: plan.tone, thesis: plan.thesis, generated_at: new Date().toISOString() },
    outline: { [kind.listKey]: items, generated_at: new Date().toISOString() },
  };
}

/** Plans one extra item from a user's description ("+" between items), placed after `afterIndex`. */
export async function planOneItem(generation, description, afterIndex) {
  const kind = kindOf(generation);
  const items = generation.outline?.[kind.listKey] || [];
  const passages = generation.source_document_ids?.length
    ? await getSourcePassagesDb(await requestEmbedding(description), ADD_ITEM_PASSAGES, generation.source_document_ids, description)
    : [];
  const prompt =
    `You are adding one ${kind.noun} to a ${kind.product}.\n\n${briefBlock(generation)}\n\n` +
    (generation.storyline ? `${storylineBlock(generation.storyline)}\n\n` : '') +
    `Current outline:\n${items.map((it, i) => `${i + 1}. ${it.title}`).join('\n')}\n\n` +
    `The new ${kind.noun} goes after ${kind.noun} ${afterIndex + 1}. The user describes it as: "${description}"\n\n` +
    (passages.length ? `Passages (id, page, section):\n${passageBlock(passages)}\n\n` : '') +
    `Return a title (specific, max 10 words), 3-6 bullets with the concrete points it will present (exact figures ` +
    `only from the passages), and the source_ids of the passages used.`;
  const schema = contentSchema(1).properties.items.items;
  const raw = await generateStructured(prompt, generateModel, schema, { think: false });

  const byId = new Map(passages.map((p) => [p.id, p]));
  let [item] = await chooseLayouts(generation, kind, [{
    id: newItemId(kind),
    title: raw.title,
    bullets: (raw.bullets || []).filter(Boolean),
    sources: [...new Set(raw.source_ids || [])].filter((id) => byId.has(id)).map((id) => toSource(byId.get(id))),
    content: null,
  }]);
  if ([kind.firstType, kind.lastType].includes(item[kind.typeKey])) item = { ...item, [kind.typeKey]: kind.defaultType };
  if (!item.sources.length) await attachSources(generation, kind, [item]);
  return item;
}

// ── Sources ──

export function sourceQuery(item) {
  return [item.title, ...(item.bullets || [])].filter(Boolean).join('. ');
}

function toSource(row, added = false) {
  return {
    chunk_id: row.id,
    page: row.page,
    heading: row.heading,
    preview: stripFigureMarkers(row.content).replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS),
    added, // true when the user added it; kept when sources are found again
  };
}

/**
 * Finds sources for items that need them, in one embedding batch. Sources the user added stay; the other slots
 * are filled by search on the item's title and bullets.
 */
export async function attachSources(generation, kind, items, { force = false } = {}) {
  if (!generation.source_document_ids?.length) return items; // pasted text only, no documents
  const needing = items.filter((it) => force || !kind.noSourceTypes.includes(it[kind.typeKey]));
  if (!needing.length) return items;

  const queries = needing.map(sourceQuery);
  const embeddings = await requestEmbeddingBatch(queries);
  for (let i = 0; i < needing.length; i++) {
    const it = needing[i];
    const kept = (it.sources || []).filter((s) => s.added);
    const taken = new Set(kept.map((s) => s.chunk_id));
    const rows = await getSourcePassagesDb(embeddings[i], kind.sourcesPerItem * 2, generation.source_document_ids, queries[i]);
    const found = rows.filter((r) => !taken.has(r.id)).slice(0, Math.max(0, kind.sourcesPerItem - kept.length)).map((r) => toSource(r));
    it.sources = [...kept, ...found];
  }
  return items;
}

/** Search the generation's documents for passages to add to an item. */
export async function searchSources(generation, q, limit = 8) {
  const embedding = await requestEmbedding(q);
  const rows = await getSourcePassagesDb(embedding, limit, generation.source_document_ids, q);
  return rows.map((r) => toSource(r, true));
}

// ── Layout suggestions (remix) ──

/** The layouts (other than the current one) that would present this item best, each with a reason. */
export async function suggestTypes(generation, index) {
  const kind = kindOf(generation);
  const item = generation.outline?.[kind.listKey]?.[index];
  if (!item) throw new Error(`${kind.noun} ${index + 1} not found`);
  const current = item[kind.typeKey];
  const candidates = kind.types.filter((t) => t !== current && t !== kind.firstType && t !== kind.lastType
    && !kind.appOnlyTypes.includes(t));
  const { source_chunk_ids: _ids, used_pages: _pages, diagram_file: _d, speaker_notes: _n, ...content } = item.content || {};

  const prompt =
    `A ${kind.noun} in a ${kind.product} currently uses the "${current}" layout.\n\n` +
    `Title: ${item.title}\nContent:\n${JSON.stringify(content, null, 2)}\n\n` +
    `Layouts to choose from:\n${candidates.map((t) => `- "${t}": ${kind.typeGuide[t]}`).join('\n')}\n\n` +
    `Pick the ${Math.min(3, candidates.length)} layouts that would present this content best, best first. ` +
    `For each give a one-line reason a user would understand, e.g. "The four steps read as a sequence".`;
  const schema = {
    type: 'object',
    properties: {
      suggestions: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          properties: { type: { type: 'string', enum: candidates }, reason: { type: 'string' } },
          required: ['type', 'reason'],
        },
      },
    },
    required: ['suggestions'],
  };
  const result = await generateStructured(prompt, generateModel, schema, { think: false });
  const seen = new Set();
  return (result.suggestions || []).filter((s) => candidates.includes(s.type) && !seen.has(s.type) && seen.add(s.type));
}
