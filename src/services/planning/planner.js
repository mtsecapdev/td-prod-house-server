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
import { verifiedFacts, sameFact } from './facts.js';
import { pickFigures } from './figurePicks.js';

const { generateModel } = config.ollama;
const PREVIEW_CHARS = 220;
const ADD_ITEM_PASSAGES = 6;
// Pasted text is read in full when planning; very long pastes are cut to stay inside the model's context.
const MAX_PASTED_CHARS = 20000;
// Slides marked by the user: a line containing only "---".
const SPLIT_RE = /\n\s*-{3,}\s*\n/;

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

// What to plan from. The planner reads whole passages, never cut short: a combustion chamber document missed
// swirl chambers and energy cells because whole-document plans saw sampled passages cut at 1,400 characters.
// - Documents that fit MATERIAL_CHARS are read in full.
// - Larger ones, for a request on a topic: whole sections, most relevant first (a section is often split across
//   passages, and the second half held swirl chambers and energy cells).
// - Larger ones, for the whole documents: passages in turns, the most relevant of every section in each round,
//   so every part is represented before any part gets more.
// Passages the conversation's answers used come first. The documents' section list shows what else exists.
// The budget is what the model's context holds besides the prompt (~4,000 tokens) and its answer, at about 3.5
// characters a token: ~72,000 characters at 32k context, more on a server with a larger one.
const MATERIAL_CHARS = Math.round((config.ollama.numCtx - config.ollama.numPredict - 4000) * 3.5);

async function planningMaterial(generation) {
  const pasted = pastedText(generation.brief);
  if (pasted) return { block: `The user's own text, to build from (source 0):\n"""\n${pasted}\n"""`, passages: [], ownText: pasted };

  const docIds = generation.source_document_ids || [];
  const full = generation.brief?.scope === 'full';
  const query = [generation.brief?.topic, generation.brief?.goal, generation.brief?.instructions].filter(Boolean).join('\n');
  const embedding = await requestEmbedding(query);
  const [all, map, pinnedRows] = await Promise.all([
    getAllPassagesDb(docIds),
    getDocumentMapDb(docIds, full ? {} : { topicEmbedding: embedding }),
    getChunksByIdsDb(generation.brief?.pinned_chunk_ids || []),
  ]);
  const size = (r) => stripFigureMarkers(r.content).length;
  let chosen;
  if (all.reduce((n, r) => n + size(r), 0) <= MATERIAL_CHARS) {
    chosen = all;
  } else {
    const ranked = await getSourcePassagesDb(embedding, all.length, docIds, query);
    const sectionOf = (r) => `${r.document_id}:${r.heading || ''}`;
    const sections = new Map();
    for (const r of all) {
      if (!sections.has(sectionOf(r))) sections.set(sectionOf(r), []);
      sections.get(sectionOf(r)).push(r);
    }
    // The order passages are considered in: by relevance, or in turns across sections.
    let order = ranked;
    if (full) {
      const queues = new Map();
      for (const r of ranked) {
        if (!queues.has(sectionOf(r))) queues.set(sectionOf(r), []);
        queues.get(sectionOf(r)).push(r);
      }
      order = [];
      for (let round = 0; order.length < ranked.length; round++) {
        for (const q of queues.values()) if (q[round]) order.push(q[round]);
      }
    }
    const taken = new Set();
    let used = 0;
    const take = (r) => { taken.add(r.id); used += size(r); };
    for (const r of pinnedRows.filter((p) => docIds.includes(p.document_id))) take(r);
    for (const r of order) {
      if (taken.has(r.id)) continue;
      // Topic: the whole section when it fits, else this passage alone when it does. Whole documents: one at a time.
      const section = full ? [r] : sections.get(sectionOf(r)).filter((x) => !taken.has(x.id));
      const sectionSize = section.reduce((n, x) => n + size(x), 0);
      if (used + sectionSize <= MATERIAL_CHARS) section.forEach(take);
      else if (used + size(r) <= MATERIAL_CHARS) take(r);
    }
    chosen = all.filter((r) => taken.has(r.id)); // reading order
  }
  const sectionList = map.sections.map((s) => `- ${s.heading}${s.page != null ? ` (p. ${s.page})` : ''}`).join('\n');
  return {
    block: `Sections of the documents:\n${sectionList}\n\nPassages (id, page, section), in reading order:\n${passageBlock(chosen)}`,
    passages: chosen,
  };
}

// ── The plan ──
//
// Two steps, so no answer is long enough to be cut off: one plan of 6 sections with 4-8 quoted facts each, from
// the whole manual, overran the model's output budget, was retried without reasoning and came back as two
// sections. 1. The outline: the content items, each with what it covers and the passages it draws on. 2. Each
// item's facts, quoted from its own passages, one call per item. The title and closing items are added in code,
// so a content item is never turned into the closing (a last section once became a summary titled "Engine
// Performance Metrics").

// The kinds the planner chooses from: the content ones (Figure items need a figure the user places; the opening
// and closing are added in code).
const plannable = (kind) => kind.types.filter((t) => !kind.appOnlyTypes.includes(t) && t !== kind.firstType && t !== kind.lastType);
const kindList = (kind) => plannable(kind).map((t) => `- "${t}": ${kind.typeGuide[t]}`).join('\n');
// The passages one item's facts are quoted from, at most (characters): its own and the rest of their sections.
const ITEM_MATERIAL_CHARS = 16000;

const pointsSchema = (kind) => ({
  type: 'array',
  maxItems: kind.planPoints.max,
  items: {
    type: 'object',
    properties: { point: { type: 'string' }, quote: { type: 'string' }, source: { type: 'integer' } },
    required: ['point', 'quote', 'source'],
  },
});

/** An item with its points, planned in one call (the user's own parts, an added item). */
function itemSchema(kind) {
  return {
    type: 'object',
    properties: { title: { type: 'string' }, kind: { type: 'string', enum: plannable(kind) }, points: pointsSchema(kind) },
    required: ['title', 'kind', 'points'],
  };
}

/** How an item's points are given, shared by all planning prompts. */
function pointRules(kind) {
  return `- points: the ${kind.planPoints.range} facts it presents. For each: point (the fact as it will be ` +
    `presented: short, with its exact figures), quote (the words in the passage that state it, copied exactly, at ` +
    `most 40 words) and source (that passage's id; 0 for the user's own text). Only facts a passage states: no ` +
    `figure, name or claim that is not in the quote.\n`;
}

/** Step 1: the content items, what each covers and the passages it draws on. */
async function planItems(generation, kind, material, count, notes) {
  const deck = kind.name === 'deck';
  const prompt =
    `You are planning a ${kind.product} for the user below, the way an expert would plan it before writing: ` +
    `at most ${count} content ${kind.nounPlural} (the title and closing ${kind.nounPlural} are added separately: ` +
    `plan only the content between them).\n\n${briefBlock(generation)}\n\n${material.block}\n\n` +
    `Kinds of ${kind.noun}:\n${kindList(kind)}\n\n` +
    `For each ${kind.noun}:\n` +
    `- title: specific to its content, at most 10 words; never generic ("Introduction", "Key points").\n` +
    `- kind: the kind that presents its content best.\n` +
    `- covers: one sentence on what it explains.\n` +
    `- source_ids: the ids of the passages its facts come from.\n\n` +
    `Rules:\n` +
    `- At most ${count}; fewer when the material is thin. Every ${kind.noun} covers something no other does: ` +
    `never repeat a subject or pad. No recap or "key takeaways" ${kind.noun}: the closing does that.\n` +
    `- One main idea per ${kind.noun}. Cover everything the user asked for.\n` +
    `- Never make a ${kind.noun} about the document itself (how to use the manual, its features or ` +
    `conventions, prerequisites, course maps, revision history, contents, references): only its subject.\n` +
    (deck
      ? `- A slide is presented, not read: one idea a speaker can say in a sentence, shown with 2-4 short points ` +
        `or one visual (a figure, numbers, steps, a comparison).\n`
      : `- A section explains one topic with ${kind.planPoints.range} facts: enough material for several paragraphs.\n`) +
    (generation.brief?.scope === 'full'
      ? `- The user wants the documents covered as a whole: cover every main section, in the documents' order ` +
        `(merge small related sections into one ${kind.noun}).\n`
      : '') +
    `- If the user asked for a particular kind (a table, a diagram, a timeline), include it where the material allows.\n` +
    `- The user's instructions decide what to emphasise; they never call for facts the passages do not state.\n` +
    `- Order them so the ${kind.product} builds from situation to conclusion.\n` +
    `Also return: title (the ${kind.product}'s title, at most 10 words), audience (who it is for, a few words; the ` +
    `user's if given), tone (2-4 adjectives), and thesis (the one sentence the ${deck ? 'audience' : 'reader'} ` +
    `should leave with).`;
  const schema = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      audience: { type: 'string' },
      tone: { type: 'string' },
      thesis: { type: 'string' },
      items: {
        type: 'array',
        minItems: 1,
        maxItems: count,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            kind: { type: 'string', enum: plannable(kind) },
            covers: { type: 'string' },
            source_ids: { type: 'array', maxItems: 8, items: { type: 'integer' } },
          },
          required: ['title', 'kind', 'covers', 'source_ids'],
        },
      },
    },
    required: ['title', 'audience', 'tone', 'thesis', 'items'],
  };
  return generateStructured(prompt, generateModel, schema, {
    think: true,
    onRetry: () => notes.push('The outline was written without the model\'s reasoning: the first attempt ran out of room.'),
  });
}

/** The passages an item's facts are quoted from: the ones it named, then the rest of their sections. */
function itemPassages(material, sourceIds) {
  const named = sourceIds.map((id) => material.passages.find((p) => p.id === id)).filter(Boolean);
  const sections = new Set(named.map((p) => `${p.document_id}:${p.heading || ''}`));
  const rows = [...named, ...material.passages.filter((p) => !named.includes(p) && sections.has(`${p.document_id}:${p.heading || ''}`))];
  const out = [];
  let used = 0;
  for (const r of rows) {
    const size = stripFigureMarkers(r.content).length;
    if (out.length && used + size > ITEM_MATERIAL_CHARS) continue;
    out.push(r);
    used += size;
  }
  return out.sort((a, b) => a.document_id - b.document_id || a.id - b.id);
}

/** Step 2: one item's facts, quoted from its own passages (or the user's text). */
async function planFacts(generation, kind, plan, index, material) {
  const item = plan.items[index];
  const rows = itemPassages(material, item.source_ids || []);
  const others = plan.items.map((it, i) => (i === index ? null : `- ${it.title}: ${it.covers}`)).filter(Boolean);
  const prompt =
    `You are planning one ${kind.noun} of a ${kind.product}.\n\n${briefBlock(generation)}\n\n` +
    `This ${kind.noun}: "${item.title}" (${item.kind}). It covers: ${item.covers}\n` +
    (others.length ? `The other ${kind.nounPlural} cover (leave their facts to them):\n${others.join('\n')}\n` : '') + '\n' +
    (rows.length ? `Passages (id, page, section):\n${passageBlock(rows)}` : material.block) + '\n\n' +
    `Return the facts this ${kind.noun} presents:\n${pointRules(kind)}` +
    `Keep each fact with what its passage is about: a passage about one engine type, system, product or process ` +
    `is not evidence about another. An example stays an example.`;
  try {
    const { points = [] } = await generateStructured(prompt, generateModel,
      { type: 'object', properties: { points: pointsSchema(kind) }, required: ['points'] }, { think: false });
    return { title: item.title, kind: item.kind, points, rows };
  } catch (err) {
    console.warn(`Facts for "${item.title}" failed: ${err.message}`);
    return { title: item.title, kind: item.kind, points: [], rows };
  }
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
 * Planned items with their points → outline items: facts checked, sources attached, kinds made to fit their
 * facts. A fact an earlier item already presents is dropped (two sections once said the same three things), and
 * items left with fewer facts than the kind needs (kinds.js planPoints.min) are dropped, unless `fixed` (the
 * user's own parts). `planned`: facts of items already in the outline. `total`: the outline's length, for kinds
 * only long ones use.
 */
function toItems(kind, rawItems, material, { fixed = false, planned = [], total = rawItems.length + 2 } = {}) {
  const byId = new Map(material.passages.map((p) => [p.id, p]));
  const items = [];
  const said = [...planned];
  for (const raw of rawItems) {
    const facts = verifiedFacts(raw.points, byId, raw.own_text || material.ownText || '').filter((f) => !said.some((s) => sameFact(f, s)));
    said.push(...facts);
    let type = plannable(kind).includes(raw.kind) ? raw.kind : kind.defaultType;
    if (total < (kind.minCount[type] || 0)) type = kind.defaultType;
    if (NEEDS[type] && !NEEDS[type](facts)) type = kind.defaultType;
    if (!fixed && facts.length < kind.planPoints.min) continue; // too little to say: no padding

    const sourceIds = [...new Set(facts.map((f) => f.chunk_id).filter(Boolean))];
    items.push({
      id: newItemId(kind),
      title: cleanTitle(raw.title),
      [kind.typeKey]: type,
      bullets: facts.map((f) => f.point),
      facts,
      sources: sourceIds.slice(0, kind.sourcesPerItem + 2).map((id) => toSource(byId.get(id))),
      content: null,
      ...(raw.own_text ? { own_text: raw.own_text } : {}),
    });
  }
  return items;
}

/** The title and closing items: no facts of their own, they are written from everyone's. */
function bookend(kind, type, title) {
  return { id: newItemId(kind), title, [kind.typeKey]: type, bullets: [], facts: [], sources: [], content: null };
}

/**
 * Builds the outline: the content items, their facts (checked), the figures that illustrate them and the
 * title and closing items, then sources for items that need them.
 */
export async function planOutline(generation) {
  const kind = kindOf(generation);
  const pasted = pastedText(generation.brief);
  if (pasted && SPLIT_RE.test(`\n${pasted}\n`)) return planFromSegments(generation, kind, pasted);

  const count = itemCount(kind, generation.brief);
  const material = await planningMaterial(generation);
  const notes = [];
  const plan = await planItems(generation, kind, material, count, notes);
  const planned = await Promise.all((plan.items || []).map((_, i) => planFacts(generation, kind, plan, i, material)));
  const content = await pickFigures(kind, toItems(kind, planned, material), generation.source_document_ids);
  const closingTitle = kind.name === 'deck' ? 'Key takeaways' : 'Summary';
  const items = [
    bookend(kind, kind.firstType, cleanTitle(plan.title) || generation.brief?.topic || kind.product),
    ...content,
    bookend(kind, kind.lastType, closingTitle),
  ];
  await attachSources(generation, kind, content.filter((it) => !it.sources.length));

  return {
    storyline: {
      audience: plan.audience, tone: plan.tone, thesis: plan.thesis, generated_at: new Date().toISOString(),
      ...(notes.length ? { notes } : {}),
    },
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
  const schema = {
    type: 'object',
    properties: {
      audience: { type: 'string' },
      tone: { type: 'string' },
      thesis: { type: 'string' },
      items: { type: 'array', minItems: parts.length, maxItems: parts.length, items: itemSchema(kind) },
    },
    required: ['audience', 'tone', 'thesis', 'items'],
  };
  const plan = await generateStructured(prompt, generateModel, schema, { think: false });

  const raw = parts.map((part, i) => ({
    ...(plan.items?.[i] || { title: part.split('\n')[0].slice(0, 80), kind: kind.defaultType, points: [] }),
    own_text: part,
  }));
  // Keep the user's structure: every part stays, as written, with no title or closing added.
  const items = toItems(kind, raw, { passages: [] }, { fixed: true, total: parts.length });
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
  const prompt =
    `You are adding one ${kind.noun} to a ${kind.product}.\n\n${briefBlock(generation)}\n\n` +
    (generation.storyline ? `${storylineBlock(generation.storyline)}\n\n` : '') +
    `Current outline:\n${items.map((it, i) => `${i + 1}. ${it.title}`).join('\n')}\n\n` +
    `The new ${kind.noun} goes after ${kind.noun} ${afterIndex + 1}. The user describes it as: "${description}"\n\n` +
    (rows.length ? `Passages (id, page, section):\n${passageBlock(rows)}\n\n` : '') +
    `Kinds of ${kind.noun}:\n${kindList(kind)}\n\n` +
    `Return:\n- title: specific, at most 10 words.\n- kind: the kind that presents it best.\n` + pointRules(kind);
  const raw = await generateStructured(prompt, generateModel, itemSchema(kind), { think: false });
  const planned = toItems(kind, [raw], { passages: rows, ownText: pastedText(generation.brief) },
    { fixed: true, planned: items.flatMap((it) => it.facts || []), total: items.length + 1 });
  const [item] = await pickFigures(kind, planned, generation.source_document_ids, { used: items.flatMap((it) => it.figure_ids || []) });
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
