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
import { getAllPassagesDb, getChunksByIdsDb, getDocumentMapDb, getSourcePassagesDb } from '../../db/chunksQueries.js';
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

// The model sometimes labels titles with their role ("Deck Title: …", "Slide 3: …"); the label is not the title.
const TITLE_LABEL_RE = /^(?:(?:deck|document|slide|section|page)\s*(?:title|\d+)?|title)\s*[:\-–]\s*/i;
function cleanTitle(title) {
  return title.replace(TITLE_LABEL_RE, '').trim() || title;
}

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
  if (generation.brief?.scope === 'full') return wholeDocumentMaterial(generation);

  const query = [generation.brief?.topic, generation.brief?.instructions].filter(Boolean).join('\n');
  const embedding = await requestEmbedding(query);
  const docIds = generation.source_document_ids || [];
  const [found, map, pinnedRows] = await Promise.all([
    getSourcePassagesDb(embedding, PLAN_PASSAGES, docIds, query),
    getDocumentMapDb(docIds, { topicEmbedding: embedding }),
    getChunksByIdsDb(generation.brief?.pinned_chunk_ids || []),
  ]);
  // Passages the conversation's answers used come first (still from these documents); search fills the rest.
  const pinned = pinnedRows.filter((r) => docIds.includes(r.document_id));
  const pinnedIds = new Set(pinned.map((r) => r.id));
  const passages = [...pinned, ...found.filter((r) => !pinnedIds.has(r.id))].slice(0, PLAN_PASSAGES);
  const ordered = [...passages].sort((a, b) => a.document_id - b.document_id || a.id - b.id); // reading order
  const sections = map.sections.map((s) => `- ${s.heading}${s.page != null ? ` (p. ${s.page})` : ''}`).join('\n');
  return {
    block: `Sections of the documents:\n${sections}\n\nPassages (id, page, section):\n${passageBlock(ordered)}`,
    passages: ordered,
  };
}

// A whole-document deck plans from every part of the documents, not the passages that best match the request:
// each section's summary, and passages spread evenly through the documents (shortened to fit the context).
const FULL_PASSAGES = 36;
const FULL_PASSAGE_CHARS = 1400;

async function wholeDocumentMaterial(generation) {
  const docIds = generation.source_document_ids || [];
  const [all, map] = await Promise.all([getAllPassagesDb(docIds), getDocumentMapDb(docIds)]);
  const step = Math.max(1, all.length / FULL_PASSAGES);
  const passages = [];
  for (let k = 0; k < all.length && passages.length < FULL_PASSAGES; k += step) passages.push(all[Math.floor(k)]);
  const shortened = passages.map((r) => ({ ...r, content: stripFigureMarkers(r.content).slice(0, FULL_PASSAGE_CHARS) }));
  const sections = map.sections
    .map((s) => `- ${s.heading}${s.page != null ? ` (p. ${s.page})` : ''}: ${s.content.replace(/^Summary:[^\n]*\n?/, '').replace(/\s+/g, ' ').slice(0, 300)}`)
    .join('\n');
  return {
    block: `The documents' sections, in order, with summaries:\n${sections}\n\nPassages (id, page, section), in reading order:\n${passageBlock(shortened)}`,
    passages,
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
    (generation.brief?.scope === 'full'
      ? `- The user wants the documents covered as a whole: cover every main section, in the documents' order ` +
        `(merge small related sections into one ${kind.noun}; skip front and back matter such as prerequisites, ` +
        `course maps and reference lists).\n`
      : '') +
    `- Keep each fact with what its passage is about: a passage about one engine type, system, product or process ` +
    `is not evidence about another, even when the wording is similar.\n` +
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
    title: cleanTitle(raw.title),
    // Passage ids belong in source_ids; the model sometimes leaves them in the text ("… [2463]").
    bullets: (raw.bullets || []).map((b) => b.replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, '').trim()).filter(Boolean),
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
const STOPWORDS = new Set('with from that this their which about into over under between overall other these those there where when what figure'.split(' '));

function keywords(text) {
  return new Set((String(text).toLowerCase().match(/[a-z][a-z0-9&-]{3,}/g) || []).filter((w) => !STOPWORDS.has(w)));
}

// Layouts that carry content a figure can't replace: numbers, quotes, a single statement, bookends.
const KEEP_TYPES = new Set(['key_stats', 'stat_focus', 'quote_highlight', 'big_idea', 'section_divider', 'key_points']);
const FIGURE_PAGE_DISTANCE = 3;
// A word in more than this share of the documents' figures ("engine" in an engine manual) says nothing about
// which figure a slide needs.
const COMMON_WORD_SHARE = 0.2;
const MIN_FIGURE_SCORE = 0.4;
// Matches this strong are taken as they are; weaker ones are checked by the model.
const SURE_FIGURE_SCORE = 0.75;

const captionOf = (f) => f.caption.replace(/^fig(ure)?\.?\s*[A-Z]?\d+(?:[.-]\d+)*[a-z]?\s*[-–—:]?\s*/i, '');

/**
 * Turns slides into Figure slides when a figure in their documents shows what they are about.
 * 1. Scores every (slide, figure) pair in code: a figure the slide names ("Figure 2-6") scores 1; otherwise the
 *    figure must sit within a few pages of the slide's sources, and the score is the share of its caption's
 *    distinctive words (its printed text, for uncaptioned figures) found in the slide, title matches counting
 *    more. Words common to many of the documents' figures are ignored.
 * 2. Each figure goes to the slide it fits best and each slide gets at most one (best pairs first).
 * 3. Strong pairs are taken; weaker ones are checked by the model (yes/no): the figure must show what the
 *    whole slide is about.
 * Earlier the model chose among candidates itself and moved figures to the wrong slides (the cooling-system
 * figure onto "Why engines need cooling", not "Cooling system components").
 * At most two per deck; number, quote and statement slides, the first and the last are left alone.
 */
async function suggestFigures(kind, items, documentIds) {
  const figures = await listFiguresDb({ documentIds });
  if (!figures.length) return items;

  const wordsOf = new Map(figures.map((f) => [f.id, {
    caption: keywords(captionOf(f)),
    labels: keywords(f.labels.slice(0, 300)),
  }]));
  const share = new Map();
  for (const { caption, labels } of wordsOf.values()) {
    for (const w of new Set([...caption, ...labels])) share.set(w, (share.get(w) || 0) + 1 / figures.length);
  }
  const distinctive = (set) => [...set].filter((w) => (share.get(w) || 0) <= COMMON_WORD_SHARE);

  const pairs = [];
  items.forEach((it, i) => {
    if (i === 0 || i === items.length - 1 || KEEP_TYPES.has(it[kind.typeKey])) return;
    const text = `${it.title} ${(it.bullets || []).join(' ')}`;
    const words = keywords(text);
    const titleWords = keywords(it.title);
    const pages = (it.sources || []).map((s) => s.page).filter((p) => p != null);
    for (const f of figures) {
      const n = figureNumber(f.caption);
      const named = n && new RegExp(`\\bfig(?:ure)?\\.?\\s*${n.replace(/[.-]/g, '[.-]')}\\b`, 'i').test(text);
      const near = f.page != null && pages.some((p) => Math.abs(p - f.page) <= FIGURE_PAGE_DISTANCE);
      let score = 0;
      if (named) score = 1;
      else if (near) {
        const { caption, labels } = wordsOf.get(f.id);
        // The caption: its distinctive words found in the slide (title matches count more). One stray word in
        // a bullet is not enough: it needs a title match or two words.
        const capKey = distinctive(caption);
        const capHits = capKey.filter((w) => words.has(w)).length;
        const capTitle = capKey.filter((w) => titleWords.has(w)).length;
        const captionScore = capKey.length && (capTitle || capHits >= 2) ? Math.min(1, (capHits + 0.5 * capTitle) / capKey.length) : 0;
        // The text printed in it (part names), for figures whose caption is general or missing: two or more hits.
        const labelKey = distinctive(labels);
        const labelHits = labelKey.filter((w) => words.has(w)).length;
        const labelScore = labelHits >= 2 ? 0.8 * Math.min(1, labelHits / Math.min(labelKey.length, 6)) : 0;
        score = Math.max(captionScore, labelScore);
      }
      if (score >= MIN_FIGURE_SCORE) pairs.push({ i, f, score });
    }
  });

  // Best pairs first; a figure goes to one slide, a slide gets one figure.
  pairs.sort((a, b) => b.score - a.score);
  const chosen = [];
  const usedSlides = new Set();
  const usedFigures = new Set();
  for (const pair of pairs) {
    if (usedSlides.has(pair.i) || usedFigures.has(pair.f.id)) continue;
    chosen.push(pair);
    usedSlides.add(pair.i);
    usedFigures.add(pair.f.id);
  }
  const approved = new Set(chosen.flatMap((p, k) => (p.score >= SURE_FIGURE_SCORE ? [k] : [])));
  const unsure = chosen.map((p, k) => ({ ...p, k })).filter((p) => !approved.has(p.k));
  if (unsure.length) for (const k of await confirmFigures(kind, items, unsure)) approved.add(k);

  let used = 0;
  chosen.forEach((p, k) => {
    if (!approved.has(k) || used >= MAX_SUGGESTED_FIGURES) return;
    items[p.i] = { ...items[p.i], [kind.typeKey]: 'figure', figure_id: p.f.id, type_reason: `Shows ${p.f.caption || 'a figure from the document'}` };
    used++;
  });
  return items;
}

/**
 * Asks the model (thinking: without it the answer flipped between runs) which of these weaker pairings really
 * show the slide's subject. Returns the approved pairs' k.
 */
async function confirmFigures(kind, items, pairs) {

  const prompt =
    `Check each pairing of a ${kind.noun} with a figure from the source documents. Answer yes only if the figure ` +
    `shows what the whole ${kind.noun} is about, so presenting the figure on it helps; answer no if it is only ` +
    `loosely related, shows something else, or the ${kind.noun} is a recap.\n\n` +
    pairs.map((p) => `[P${p.k + 1}] ${kind.noun} "${items[p.i].title}": ${(items[p.i].bullets || []).join('; ')}\n` +
      `  figure: ${p.f.caption || '(no caption)'}. Text in it: ${p.f.labels.slice(0, 240)}`).join('\n\n');
  const schema = {
    type: 'object',
    properties: {
      answers: {
        type: 'array',
        items: {
          type: 'object',
          properties: { pair: { type: 'string', enum: pairs.map((p) => `P${p.k + 1}`) }, shows_subject: { type: 'boolean' } },
          required: ['pair', 'shows_subject'],
        },
      },
    },
    required: ['answers'],
  };
  const { answers = [] } = await generateStructured(prompt, generateModel, schema, { think: true });
  return answers.filter((a) => a.shows_subject).map((a) => Number(String(a.pair).slice(1)) - 1);
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
