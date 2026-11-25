// Planning for decks and documents: turns the user's request into an outline of items (title, kind, the facts
// it presents), each tied to the passages it draws on.
//
// It plans from the documents' actual passages, the way the document chat answers. Every planned point comes
// with the words in a passage that state it; points whose words aren't there are dropped in code (facts.js),
// and items left with nothing to say are dropped, so a deck is as long as its material supports, up to the
// length asked for, and never padded. The planner also picks each item's kind; the documents' figures are put
// on the items they illustrate in a step of their own (figurePicks.js).
import { randomBytes } from 'node:crypto';
import config from '../../config.js';
import { generateStructured, requestEmbedding, requestEmbeddingBatch } from '../llm.js';
import { getAllPassagesDb, getChunksByIdsDb, getDocumentMapDb, getSourcePassagesDb } from '../../db/chunksQueries.js';
import { kindOf, briefBlock, storylineBlock, itemCount } from './kinds.js';
import { readablePassage, stripFigureMarkers } from '../figures.js';
import { verifiedFacts } from './facts.js';
import { pickFigures } from './figurePicks.js';

const { generateModel } = config.ollama;
const PREVIEW_CHARS = 220;
// Passages read when planning: enough to cover a typical report the way chat does (~8-10k tokens).
const PLAN_PASSAGES = 24;
const ADD_ITEM_PASSAGES = 6;
// Pasted text is read in full when planning; very long pastes are cut to stay inside the model's context.
const MAX_PASTED_CHARS = 20000;
// Slides marked by the user: a line containing only "---".
const SPLIT_RE = /\n\s*-{3,}\s*\n/;
const MAX_POINTS = 6;

// The model sometimes labels titles with their role ("Deck Title: …", "Slide 3: …"); the label is not the title.
const TITLE_LABEL_RE = /^(?:(?:deck|document|slide|section|page)\s*(?:title|\d+)?|title)\s*[:\-–]\s*/i;
function cleanTitle(title) {
  return String(title || '').replace(TITLE_LABEL_RE, '').trim() || String(title || '');
}

function newItemId(kind) {
  return kind.idPrefix + randomBytes(4).toString('hex');
}

export function pastedText(brief) {
  return (brief?.source_text || '').trim().slice(0, MAX_PASTED_CHARS);
}

// ── Material ──

function passageBlock(rows) {
  return rows.map((r) => `[${r.id}] p.${r.page ?? '?'}${r.heading ? ` · ${r.heading}` : ''}\n${stripFigureMarkers(r.content).trim()}`).join('\n\n');
}

// What to plan from: the passages most relevant to the request (plus the documents' section list, so the
// plan knows what else exists), the whole documents, or the user's own text.
async function planningMaterial(generation) {
  const pasted = pastedText(generation.brief);
  if (pasted) return { block: `The user's own text, to build from (source 0):\n"""\n${pasted}\n"""`, passages: [], ownText: pasted };
  if (generation.brief?.scope === 'full') return wholeDocumentMaterial(generation);

  const query = [generation.brief?.topic, generation.brief?.goal, generation.brief?.instructions].filter(Boolean).join('\n');
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
  // Shortened for the prompt; the facts are checked against what the planner was shown.
  const shown = passages.map((r) => ({ ...r, content: stripFigureMarkers(r.content).slice(0, FULL_PASSAGE_CHARS) }));
  const sections = map.sections
    .map((s) => `- ${s.heading}${s.page != null ? ` (p. ${s.page})` : ''}: ${s.content.replace(/^Summary:[^\n]*\n?/, '').replace(/\s+/g, ' ').slice(0, 300)}`)
    .join('\n');
  return {
    block: `The documents' sections, in order, with summaries:\n${sections}\n\nPassages (id, page, section), in reading order:\n${passageBlock(shown)}`,
    passages: shown,
  };
}

// ── The plan ──

// The kinds the planner chooses from (a Figure item needs a figure the user places).
const plannable = (kind) => kind.types.filter((t) => !kind.appOnlyTypes.includes(t));

function itemSchema(kind) {
  return {
    type: 'object',
    properties: {
      title: { type: 'string' },
      kind: { type: 'string', enum: plannable(kind) },
      points: {
        type: 'array',
        maxItems: MAX_POINTS,
        items: {
          type: 'object',
          properties: { point: { type: 'string' }, quote: { type: 'string' }, source: { type: 'integer' } },
          required: ['point', 'quote', 'source'],
        },
      },
    },
    required: ['title', 'kind', 'points'],
  };
}

function planSchema(kind, count) {
  return {
    type: 'object',
    properties: {
      audience: { type: 'string' },
      tone: { type: 'string' },
      thesis: { type: 'string' },
      items: { type: 'array', minItems: Math.min(3, count), maxItems: count, items: itemSchema(kind) },
    },
    required: ['audience', 'tone', 'thesis', 'items'],
  };
}

const kindList = (kind) => plannable(kind).map((t) => `- "${t}": ${kind.typeGuide[t]}`).join('\n');

/** How every item's points are given, shared by all planning prompts. */
function pointRules(kind) {
  return `- points: the facts it presents (none for the first and last ${kind.noun}). For each: point (the fact as ` +
    `it will be presented: short, with its exact figures), quote (the words in the passage that state it, copied ` +
    `exactly, at most 40 words) and source (that passage's id; 0 for the user's own text). Only facts a passage ` +
    `states: no figure, name or claim that is not in the quote.\n`;
}

async function planContent(generation, kind, material, count) {
  const deck = kind.name === 'deck';
  const opening = deck ? 'a title slide saying what the deck covers' : 'a title page with the document\'s purpose';
  const closing = deck ? 'the takeaways and what to do next' : 'a summary and next steps';
  const prompt =
    `You are planning a ${kind.product} of at most ${count} ${kind.nounPlural} for the user below, the way an ` +
    `expert would plan it before writing.\n\n${briefBlock(generation)}\n\n${material.block}\n\n` +
    `Kinds of ${kind.noun}:\n${kindList(kind)}\n\n` +
    `For each ${kind.noun}:\n` +
    `- title: specific to its content, at most 10 words; never generic ("Introduction", "Key points").\n` +
    `- kind: the kind that presents its facts best.\n` +
    pointRules(kind) + '\n' +
    `Rules:\n` +
    `- At most ${count} ${kind.nounPlural}: the first is ${opening}; the last is ${closing}. Use fewer when the ` +
    `material is thin. Every ${kind.noun} must bring facts no other ${kind.noun} has: never repeat a fact, figure ` +
    `or example, and never pad. The last ${kind.noun} is the only recap: no "key takeaways" or summary before it.\n` +
    `- One main idea per ${kind.noun}. Cover everything the user asked for.\n` +
    `- Never make a ${kind.noun} about the document itself (how to use the manual, its features or ` +
    `conventions, prerequisites, course maps, revision history, contents, references): only its subject.\n` +
    (deck
      ? `- A slide is presented, not read: one idea a speaker can say in a sentence, shown with 2-4 short points ` +
        `or one visual (a figure, numbers, steps, a comparison). Detail belongs in the speaker notes.\n`
      : '') +
    (generation.brief?.scope === 'full'
      ? `- The user wants the documents covered as a whole: cover every main section, in the documents' order ` +
        `(merge small related sections into one ${kind.noun}).\n`
      : '') +
    `- Keep each fact with what its passage is about: a passage about one engine type, system, product or process ` +
    `is not evidence about another, even when the wording is similar. An example in a passage stays an example.\n` +
    `- If the user asked for a particular kind (a table, a diagram, a timeline), include it where the facts allow.\n` +
    `- Order them so the ${kind.product} builds from situation to conclusion.\n` +
    `Also return: audience (who it is for, a few words; the user's if given), tone (2-4 adjectives), and thesis ` +
    `(the one sentence the ${deck ? 'audience' : 'reader'} should leave with).`;
  return generateStructured(prompt, generateModel, planSchema(kind, count), { think: true });
}

// What a kind needs from its facts to work; without it the item becomes the default kind.
const NEEDS = {
  steps: (facts) => facts.length >= 2,
  compare: (facts) => facts.length >= 2,
  table: (facts) => facts.length >= 2,
  diagram: (facts) => facts.length >= 2,
  numbers: (facts) => facts.some((f) => /\d/.test(f.point)),
  procedure: (facts) => facts.length >= 2,
  key_points: (facts) => facts.length >= 2,
  reference_table: (facts) => facts.length >= 2,
};

/**
 * Raw planned items → outline items: facts checked, sources attached, kinds made to fit their position and facts.
 * Items in the middle with no fact left are dropped. `fixed`: keep every item (the user's own parts).
 */
function toItems(kind, rawItems, material, { fixed = false, bookends = true } = {}) {
  const byId = new Map(material.passages.map((p) => [p.id, p]));
  const last = rawItems.length - 1;
  const items = [];
  rawItems.forEach((raw, i) => {
    const ownText = raw.own_text || material.ownText || '';
    const facts = verifiedFacts(raw.points, byId, ownText);
    let type = plannable(kind).includes(raw.kind) ? raw.kind : kind.defaultType;
    const bookend = bookends && (i === 0 || (i === last && rawItems.length > 2));
    if (bookend) type = i === 0 ? kind.firstType : kind.lastType;
    else if (type === kind.firstType || type === kind.lastType || rawItems.length < (kind.minCount[type] || 0)) type = kind.defaultType;
    if (NEEDS[type] && !NEEDS[type](facts)) type = kind.defaultType;
    if (!bookend && !fixed && !facts.length) return; // nothing to say: no padding

    const sourceIds = [...new Set(facts.map((f) => f.chunk_id).filter(Boolean))];
    const item = {
      id: newItemId(kind),
      title: cleanTitle(raw.title),
      [kind.typeKey]: type,
      bullets: facts.map((f) => f.point),
      facts,
      sources: sourceIds.slice(0, kind.sourcesPerItem + 2).map((id) => toSource(byId.get(id))),
      content: null,
      ...(raw.own_text ? { own_text: raw.own_text } : {}),
    };
    items.push(item);
  });
  return items;
}

/** Builds the outline: the plan from the material, its facts checked, the figures that illustrate it, then sources
 * for items that need them. */
export async function planOutline(generation) {
  const kind = kindOf(generation);
  const pasted = pastedText(generation.brief);
  if (pasted && SPLIT_RE.test(`\n${pasted}\n`)) return planFromSegments(generation, kind, pasted);

  const count = itemCount(kind, generation.brief);
  const material = await planningMaterial(generation);
  const plan = await planContent(generation, kind, material, count);
  const items = await pickFigures(kind, toItems(kind, plan.items || [], material), generation.source_document_ids);
  // Items the plan gave no passages (and that need evidence) get sources by search.
  await attachSources(generation, kind, items.filter((it) => !it.sources.length));

  return {
    storyline: { audience: plan.audience, tone: plan.tone, thesis: plan.thesis, generated_at: new Date().toISOString() },
    outline: { [kind.listKey]: items, generated_at: new Date().toISOString() },
  };
}

// The user split their text into slides with "---": one item per part, in their order, each carrying its
// part as `own_text`. The model titles each part, picks its kind and quotes its points from the part.
async function planFromSegments(generation, kind, pasted) {
  const parts = pasted.split(SPLIT_RE).map((p) => p.trim()).filter(Boolean).slice(0, kind.countRange[1]);
  const prompt =
    `The user wrote a ${kind.product} as ${parts.length} parts, one ${kind.noun} each, in this order.\n\n` +
    `${briefBlock(generation)}\n\n` +
    parts.map((p, i) => `--- Part ${i + 1} ---\n${p}`).join('\n\n') + '\n\n' +
    `Kinds of ${kind.noun}:\n${kindList(kind)}\n\n` +
    `Return audience (who it is for, a few words), tone (2-4 adjectives), thesis (one sentence) and exactly ` +
    `${parts.length} items, item i for part i:\n` +
    `- title: the part's own heading if it has one, otherwise a specific title of at most 10 words.\n` +
    `- kind: the kind that presents the part best.\n` +
    `- points: what the part says, each with point (short), quote (the part's own words that state it) and source 0.`;
  const schema = planSchema(kind, parts.length);
  schema.properties.items.minItems = parts.length;
  const plan = await generateStructured(prompt, generateModel, schema, { think: false });

  const raw = parts.map((part, i) => ({
    ...(plan.items?.[i] || { title: part.split('\n')[0].slice(0, 80), kind: kind.defaultType, points: [] }),
    own_text: part,
  }));
  // Keep the user's structure: every part stays, bookend kinds only where they fit.
  const items = toItems(kind, raw, { passages: [] }, { fixed: true, bookends: false });
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
  const rows = generation.source_document_ids?.length
    ? await getSourcePassagesDb(await requestEmbedding(description), ADD_ITEM_PASSAGES, generation.source_document_ids, description)
    : [];
  const choosable = plannable(kind).filter((t) => t !== kind.firstType && t !== kind.lastType);
  const prompt =
    `You are adding one ${kind.noun} to a ${kind.product}.\n\n${briefBlock(generation)}\n\n` +
    (generation.storyline ? `${storylineBlock(generation.storyline)}\n\n` : '') +
    `Current outline:\n${items.map((it, i) => `${i + 1}. ${it.title}`).join('\n')}\n\n` +
    `The new ${kind.noun} goes after ${kind.noun} ${afterIndex + 1}. The user describes it as: "${description}"\n\n` +
    (rows.length ? `Passages (id, page, section):\n${passageBlock(rows)}\n\n` : '') +
    `Kinds of ${kind.noun}:\n${choosable.map((t) => `- "${t}": ${kind.typeGuide[t]}`).join('\n')}\n\n` +
    `Return:\n- title: specific, at most 10 words.\n- kind: the kind that presents it best.\n` +
    pointRules(kind).replace(` (none for the first and last ${kind.noun})`, '');
  const raw = await generateStructured(prompt, generateModel, itemSchema(kind), { think: false });
  const planned = toItems(kind, [raw], { passages: rows, ownText: pastedText(generation.brief) }, { fixed: true, bookends: false });
  const [item] = await pickFigures(kind, planned, generation.source_document_ids);
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

// ── Kind suggestions (remix) ──

/** The kinds (other than the current one) that would present this item best, each with a reason. */
export async function suggestTypes(generation, index) {
  const kind = kindOf(generation);
  const item = generation.outline?.[kind.listKey]?.[index];
  if (!item) throw new Error(`${kind.noun} ${index + 1} not found`);
  const current = item[kind.typeKey];
  const candidates = kind.types.filter((t) => t !== current && t !== kind.firstType && t !== kind.lastType
    && !kind.appOnlyTypes.includes(t));
  const { source_chunk_ids: _ids, used_pages: _pages, diagram_file: _d, speaker_notes: _n, pictures: _p, ...content } = item.content || {};

  const prompt =
    `A ${kind.noun} in a ${kind.product} is currently a "${current}" ${kind.noun}.\n\n` +
    `Title: ${item.title}\nContent:\n${JSON.stringify(content, null, 2)}\n\n` +
    `Kinds to choose from:\n${candidates.map((t) => `- "${t}": ${kind.typeGuide[t]}`).join('\n')}\n\n` +
    `Pick the ${Math.min(3, candidates.length)} kinds that would present this content best, best first. ` +
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
