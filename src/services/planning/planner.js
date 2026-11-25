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
import { stripFigureMarkers, readablePassage, figureNumber } from '../figures.js';
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
    `- Never make a ${kind.noun} about the document itself (how to use the manual, its features or ` +
    `conventions, prerequisites, course maps, revision history, contents, references): only its subject.\n` +
    (kind.name === 'deck'
      ? `- A slide is presented, not read: one idea a speaker can say in a sentence, shown with 2-4 short points ` +
        `or one visual (a figure, a number, a sequence, a comparison). Detail belongs in the speaker notes.\n`
      : '') +
    (generation.brief?.scope === 'full'
      ? `- The user wants the documents covered as a whole: cover every main section, in the documents' order ` +
        `(merge small related sections into one ${kind.noun}).\n`
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
    bullets: (raw.bullets || []).map((b) => b.replace(/\s*\[(?:p\. )?\d+(?:\s*,\s*\d+)*\]/g, '').trim()).filter(Boolean),
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

// Layouts a figure can't add to: numbers, quotes, a single statement, bookends, and those that are diagrams already.
const KEEP_TYPES = new Set(['stat_focus', 'quote_highlight', 'big_idea', 'section_divider', 'key_points', 'process_flow',
  'timeline', 'comparison_table', 'diagram', 'procedure', 'reference_table']);
// Slide and figure texts are compared by meaning (the search model). Scores bunch together (0.6-0.8 on the
// engine manual), so a figure needs to be from nearby pages, or a close match on meaning alone.
const FIGURE_PAGE_DISTANCE = 2;
const NEAR_FIGURE_SIMILARITY = 0.6;
const FAR_FIGURE_SIMILARITY = 0.72;
const NEAR_BONUS = 0.05;
// Matches this strong are taken as they are; weaker ones are checked by the model.
const SURE_FIGURE_SCORE = 0.76;
// A planned item with this many points is a list: the figure goes beside it, not instead of it.
const LIST_POINTS = 3;

const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / Math.sqrt(na * nb);
};

/**
 * Puts the documents' figures on the slides/sections they illustrate. The decks had none: matching on shared
 * caption words missed obvious pairs ("Engine timing" and Figure 2-25), and at most two were allowed.
 * 1. Every (item, figure) pair is scored by meaning: the item's title and points against the figure's caption
 *    and the words printed in it; a figure the item names ("Figure 2-6") scores 1, a figure from nearby pages
 *    gets a small bonus.
 * 2. Best pairs first, each item gets at most one figure and each figure goes to one item.
 * 3. Strong pairs are taken; weaker ones are checked by the model (does the figure show what the item is about?).
 * A list keeps its points with the figure beside it; an item with little text becomes a Figure item.
 */
async function suggestFigures(kind, items, documentIds) {
  const figures = await listFiguresDb({ documentIds });
  if (!figures.length) return items;
  const candidates = items.map((it, i) => ({ it, i }))
    .filter(({ it, i }) => i > 0 && i < items.length - 1 && !KEEP_TYPES.has(it[kind.typeKey]) && !it.figure_id);
  if (!candidates.length) return items;

  const figureText = (f) => `${f.caption || ''}. ${String(f.labels || '').slice(0, 240)}`.trim();
  const itemText = (it) => `${it.title}. ${(it.bullets || []).join(' ')}`;
  const [figVecs, itemVecs] = await Promise.all([
    requestEmbeddingBatch(figures.map(figureText)),
    requestEmbeddingBatch(candidates.map(({ it }) => itemText(it))),
  ]);

  const pairs = [];
  candidates.forEach(({ it, i }, c) => {
    const text = itemText(it);
    const pages = (it.sources || []).map((s) => s.page).filter((p) => p != null);
    figures.forEach((f, k) => {
      const n = figureNumber(f.caption);
      if (n && new RegExp(`\\bfig(?:ure)?\\.?\\s*${n.replace(/[.-]/g, '[.-]')}\\b`, 'i').test(text)) {
        pairs.push({ i, f, score: 1 });
        return;
      }
      const near = f.page != null && pages.some((p) => Math.abs(p - f.page) <= FIGURE_PAGE_DISTANCE);
      const sim = cosine(itemVecs[c], figVecs[k]);
      if (sim >= (near ? NEAR_FIGURE_SIMILARITY : FAR_FIGURE_SIMILARITY)) pairs.push({ i, f, score: sim + (near ? NEAR_BONUS : 0) });
    });
  });

  pairs.sort((a, b) => b.score - a.score);
  const chosen = [];
  const usedItems = new Set();
  const usedFigures = new Set();
  for (const pair of pairs) {
    if (usedItems.has(pair.i) || usedFigures.has(pair.f.id)) continue;
    chosen.push(pair);
    usedItems.add(pair.i);
    usedFigures.add(pair.f.id);
  }
  const approved = new Set(chosen.flatMap((p, k) => (p.score >= SURE_FIGURE_SCORE ? [k] : [])));
  const unsure = chosen.map((p, k) => ({ ...p, k })).filter((p) => !approved.has(p.k));
  if (unsure.length) for (const k of await confirmFigures(kind, items, unsure)) approved.add(k);

  chosen.forEach((p, k) => {
    if (!approved.has(k)) return;
    const item = items[p.i];
    const caption = p.f.caption || 'a figure from the document';
    const isList = (item.bullets || []).length >= LIST_POINTS && p.score < 1;
    items[p.i] = isList
      ? { ...item, figure_id: p.f.id, figure_beside: true, type_reason: `${item.type_reason ? `${item.type_reason}; ` : ''}with ${caption} beside` }
      : { ...item, [kind.typeKey]: 'figure', figure_id: p.f.id, type_reason: `Shows ${caption}` };
  });
  return items;
}

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
    preview: readablePassage(row.content).replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS),
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
