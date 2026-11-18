// Planning for decks and documents (Gamma-style): one job turns the user's prompt into an outline of N items,
// each a title plus a few bullets, with sources found per item.
//
// Internally it first drafts a storyline (thesis + ordered key messages) from the document map, the overviews
// and section summaries stored at ingestion, so the outline covers the documents and reads as one argument.
// The user never edits the storyline; it is saved and given to the writer as context.
//
// Planning never states figures: summaries carry few exact numbers, and a model asked to plan with them fills
// gaps with invented ones. Figures are added only when writing, from each item's sources.
import { randomBytes } from 'node:crypto';
import config from '../../config.js';
import { generateStructured, requestEmbedding, requestEmbeddingBatch } from '../llm.js';
import { getDocumentMapDb, getSourcePassagesDb } from '../../db/chunksQueries.js';
import { kindOf, briefBlock, storylineBlock, itemCount } from './kinds.js';

const { generateModel } = config.ollama;
const PREVIEW_CHARS = 220;
const NO_FIGURES =
  'Do not state numbers, percentages, amounts or dates; name what will be shown instead ' +
  '(write "how much of the spend the top suppliers hold", not "86% of spend"). Figures are added later from the sources.';

function newItemId(kind) {
  return kind.idPrefix + randomBytes(4).toString('hex');
}

async function documentMap(generation) {
  const topicEmbedding = await requestEmbedding(generation.brief?.topic || '');
  return getDocumentMapDb(generation.source_document_ids, { topicEmbedding });
}

function mapBlock(map, { onlySectionIds } = {}) {
  const lines = [];
  for (const o of map.overviews) lines.push(`Document "${o.name}" overview:\n${o.content}`);
  const sections = onlySectionIds ? map.sections.filter((s) => onlySectionIds.has(s.id)) : map.sections;
  lines.push('Sections (id, heading: summary):');
  for (const s of sections) lines.push(`- [${s.id}] ${s.heading}: ${s.content.replace(/\s+/g, ' ').trim()}`);
  return lines.join('\n');
}

// ── Storyline (internal) ──

const storylineSchema = {
  type: 'object',
  properties: {
    audience: { type: 'string' },
    tone: { type: 'string' },
    thesis: { type: 'string' },
    messages: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, section_ids: { type: 'array', items: { type: 'integer' } } },
        required: ['text', 'section_ids'],
      },
    },
  },
  required: ['audience', 'tone', 'thesis', 'messages'],
};

// `material` is what the plan is built from: the document map, or the user's pasted text.
async function draftStoryline(generation, kind, material, count) {
  const messageCount = Math.max(2, Math.min(6, Math.round(count / 3)));
  const prompt =
    `You are planning a ${kind.product} of ${count} ${kind.nounPlural} from the material below.\n\n` +
    `${briefBlock(generation)}\n\n${material.block}\n\n` +
    `Produce:\n` +
    `- audience: who this is for, in a few words. Use the user's audience if given, otherwise infer it from the request.\n` +
    `- tone: 2-4 adjectives for the voice, e.g. "clear, practical, encouraging".\n` +
    `- thesis: the one sentence the ${kind.name === 'deck' ? 'audience' : 'reader'} should leave with.\n` +
    `- messages: about ${messageCount} key messages in the order to tell them. Each is one sentence making a different ` +
    `claim (never two about the same example or incident), with the ids of the sections that support it.\n` +
    `Serve what the user asked for. Use only what the material contains. ${NO_FIGURES}`;

  const result = await generateStructured(prompt, generateModel, storylineSchema, { think: true });
  const byId = new Map(material.sections.map((s) => [s.id, s]));
  return {
    audience: result.audience,
    tone: result.tone,
    thesis: result.thesis,
    messages: (result.messages || []).map((m, i) => ({
      id: `m${i + 1}`,
      text: m.text,
      section_ids: [...new Set((m.section_ids || []).filter((id) => byId.has(id)))],
    })),
  };
}

// ── Outline ──

function itemSchema(kind) {
  return {
    type: 'object',
    properties: {
      message_id: { type: 'string' },
      title: { type: 'string' },
      bullets: { type: 'array', items: { type: 'string' } },
      type: { type: 'string', enum: kind.types },
      type_reason: { type: 'string' },
    },
    required: ['message_id', 'title', 'bullets', 'type', 'type_reason'],
  };
}

function typeGuideBlock(kind) {
  return kind.types.map((t) => `- "${t}": ${kind.typeGuide[t]}`).join('\n');
}

function itemRules(kind) {
  return (
    `For each ${kind.noun}:\n` +
    `- title: specific to its content (max 10 words). Not generic ("Introduction", "Key points").\n` +
    `- bullets: 2-5 short lines saying what it will cover, as the user would jot them in an outline.\n` +
    `- type: the type whose purpose matches its content (a sequence of steps, a comparison, several related figures, ` +
    `a process with decisions, dated events...). "${kind.defaultType}" only when nothing more specific fits. Vary the ` +
    `types across the ${kind.product}: no type more than twice in a row, and a specialised type at most twice overall ` +
    `unless the user asked for more.\n` +
    `- type_reason: a few words on why that type fits.\n` +
    `- message_id: the key message it serves, or "" for the first and last.\n` +
    NO_FIGURES
  );
}

// Pasted text is read in full when planning; very long pastes are cut to stay inside the model's context.
const MAX_PASTED_CHARS = 20000;
// Slides marked by the user: a line containing only "---".
const SPLIT_RE = /\n\s*-{3,}\s*\n/;

export function pastedText(brief) {
  return (brief?.source_text || '').trim().slice(0, MAX_PASTED_CHARS);
}

/** Builds the whole plan: storyline, outline of items, and sources per item. */
export async function planOutline(generation) {
  const kind = kindOf(generation);
  const pasted = pastedText(generation.brief);
  if (pasted && SPLIT_RE.test(`\n${pasted}\n`)) return planFromSegments(generation, kind, pasted);

  const count = itemCount(kind, generation.brief);
  let material;
  if (pasted) {
    material = { block: `The user's own text, to build from:\n\"\"\"\n${pasted}\n\"\"\"`, sections: [] };
  } else {
    const map = await documentMap(generation);
    material = { block: `What the documents contain:\n${mapBlock(map)}`, sections: map.sections, map };
  }
  const storyline = await draftStoryline(generation, kind, material, count);
  const inScope = new Set(storyline.messages.flatMap((m) => m.section_ids));
  const materialForOutline = material.map
    ? `Sections the storyline draws on:\n${mapBlock(material.map, { onlySectionIds: inScope.size ? inScope : undefined })}`
    : material.block;

  const prompt =
    `You are outlining a ${kind.product} of exactly ${count} ${kind.nounPlural}.\n\n` +
    `${briefBlock(generation)}\n\nStoryline:\n${storylineBlock(storyline)}\n\n` +
    `${materialForOutline}\n\n` +
    `${kind.noun[0].toUpperCase() + kind.noun.slice(1)} types and what each is for:\n${typeGuideBlock(kind)}\n\n` +
    `${itemRules(kind)}\n\n` +
    `Rules:\n` +
    `- Exactly ${count} ${kind.nounPlural}. The first is "${kind.firstType}" and the last is "${kind.lastType}"; no other uses those types.\n` +
    (count < 8 && kind.types.includes('section_divider') ? `- No "section_divider": the deck is too short for parts.\n` : '') +
    `- Follow the order of the key messages; every message gets at least one ${kind.noun}.\n` +
    `- Each ${kind.noun} covers different ground.` +
    (requestedTypes(kind, generation.brief).length
      ? `\n- The user asked for these layouts; include each at least once where it fits best: ` +
        `${requestedTypes(kind, generation.brief).map((t) => `"${t}"`).join(', ')}.`
      : '');

  const schema = { type: 'object', properties: { items: { type: 'array', items: itemSchema(kind) } }, required: ['items'] };
  const result = await generateStructured(prompt, generateModel, schema, { think: true });

  let items = (result.items || []).filter((raw) => raw.title).slice(0, kind.countRange[1]).map((raw) => toItem(kind, raw));
  items = ensureRequestedTypes(kind, generation.brief, cleanTypes(kind, items));
  await attachSources(generation, kind, items);

  return {
    storyline: { ...storyline, generated_at: new Date().toISOString() },
    outline: { [kind.listKey]: items, generated_at: new Date().toISOString() },
  };
}

// The user split their text into slides with "---": one item per part, in their order, each carrying its
// part as `own_text`. The model only titles, summarises and picks a layout for each part.
async function planFromSegments(generation, kind, pasted) {
  const parts = pasted.split(SPLIT_RE).map((p) => p.trim()).filter(Boolean).slice(0, kind.countRange[1]);
  const prompt =
    `The user wrote a ${kind.product} as ${parts.length} parts, one ${kind.noun} each, in this order.\n\n` +
    `${briefBlock(generation)}\n\n` +
    parts.map((p, i) => `--- Part ${i + 1} ---\n${p}`).join('\n\n') + '\n\n' +
    `${kind.noun[0].toUpperCase() + kind.noun.slice(1)} types and what each is for:\n${typeGuideBlock(kind)}\n\n` +
    `Return audience (who it is for, a few words), tone (2-4 adjectives) and exactly ${parts.length} items, item i for part i:\n` +
    `- title: the part's own heading if it has one, otherwise a specific title (max 10 words).\n` +
    `- bullets: 2-5 short lines on what the part covers, taken from its text.\n` +
    `- type: the type that best fits the part's content; "${kind.firstType}" only for part 1 if it is an opening, ` +
    `"${kind.lastType}" only for the last part if it wraps up.\n- type_reason: a few words.\n- message_id: "".`;
  const schema = {
    type: 'object',
    properties: {
      audience: { type: 'string' },
      tone: { type: 'string' },
      items: { type: 'array', minItems: parts.length, maxItems: parts.length, items: itemSchema(kind) },
    },
    required: ['audience', 'tone', 'items'],
  };
  const result = await generateStructured(prompt, generateModel, schema, { think: false });

  const items = parts.map((part, i) => {
    const raw = result.items?.[i] || { title: part.split('\n')[0].slice(0, 80), bullets: [], type: kind.defaultType };
    const item = toItem(kind, raw);
    const t = item[kind.typeKey];
    // Keep the user's structure: bookend types only where they fit, nothing forced.
    if ((t === kind.firstType && i !== 0) || (t === kind.lastType && i !== parts.length - 1)) item[kind.typeKey] = kind.defaultType;
    return { ...item, own_text: part };
  });
  await attachSources(generation, kind, items);
  return {
    storyline: { audience: result.audience, tone: result.tone, thesis: '', messages: [], generated_at: new Date().toISOString() },
    outline: { [kind.listKey]: items, generated_at: new Date().toISOString() },
  };
}

function toItem(kind, raw) {
  return {
    id: newItemId(kind),
    message_id: raw.message_id || '',
    title: raw.title,
    bullets: (raw.bullets || []).map((b) => b.trim()).filter(Boolean).slice(0, 6),
    [kind.typeKey]: kind.types.includes(raw.type) ? raw.type : kind.defaultType,
    type_reason: raw.type_reason || '',
    sources: [],
    content: null,
  };
}

// Layouts the user asked for by name in their request or instructions. They are requirements: the outline
// prompt says so, and ensureRequestedTypes() checks the result.
const REQUEST_PATTERNS = {
  diagram: /\b(diagrams?|mermaid|flow ?charts?|flow diagrams?|process maps?|org charts?|mind ?maps?)\b/i,
  timeline: /\btimelines?\b/i,
  comparison_table: /\b(comparison tables?|tables?)\b/i,
  reference_table: /\btables?\b/i,
  key_stats: /\b(key (stats|figures|numbers)|kpis?|statistics|metrics)\b/i,
  process_flow: /\bprocess flows?\b/i,
  procedure: /\b(procedures?|step[- ]by[- ]step)\b/i,
};

function requestedTypes(kind, brief = {}) {
  const text = `${brief.topic || ''}\n${brief.instructions || ''}`;
  return kind.types.filter((t) => REQUEST_PATTERNS[t]?.test(text));
}

/**
 * Makes sure every layout the user asked for appears at least once: a missing one replaces the middle item that
 * is still on the default layout (or, failing that, any middle item not already holding a requested layout).
 */
function ensureRequestedTypes(kind, brief, items) {
  const wanted = requestedTypes(kind, brief);
  for (const type of wanted) {
    if (items.some((it) => it[kind.typeKey] === type)) continue;
    const middle = items.slice(1, -1);
    const target = middle.find((it) => it[kind.typeKey] === kind.defaultType)
      || middle.find((it) => !wanted.includes(it[kind.typeKey]));
    if (target) {
      target[kind.typeKey] = type;
      target.type_reason = 'You asked for this layout';
    }
  }
  return items;
}

// The first and last types are fixed (title/closing, heading/summary), and section dividers only make sense in
// long decks. The model occasionally drifts on both.
function cleanTypes(kind, items) {
  return items.map((it, i) => {
    const t = it[kind.typeKey];
    const last = i === items.length - 1 && items.length > 1;
    if (i === 0) return { ...it, [kind.typeKey]: kind.firstType, message_id: '' };
    if (last) return { ...it, [kind.typeKey]: kind.lastType, message_id: '' };
    if (t === kind.firstType || t === kind.lastType || (t === 'section_divider' && items.length < 8)) {
      return { ...it, [kind.typeKey]: kind.defaultType };
    }
    return it;
  });
}

/** Plans one extra item from a user's description ("Add slide with AI"), placed after `afterIndex`. */
export async function planOneItem(generation, description, afterIndex) {
  const kind = kindOf(generation);
  const items = generation.outline?.[kind.listKey] || [];
  const outlineLines = items.map((it, i) => `${i + 1}. ${it[kind.typeKey]} | ${it.title}`).join('\n');
  const prompt =
    `You are adding one ${kind.noun} to a ${kind.product}.\n\n${briefBlock(generation)}\n\n` +
    (generation.storyline ? `Storyline:\n${storylineBlock(generation.storyline)}\n\n` : '') +
    `Current outline:\n${outlineLines}\n\nThe new ${kind.noun} goes after ${kind.noun} ${afterIndex + 1}. ` +
    `The user describes it as: "${description}"\n\n` +
    `${kind.noun[0].toUpperCase() + kind.noun.slice(1)} types:\n${typeGuideBlock(kind)}\n\n${itemRules(kind)}\n` +
    `Do not use "${kind.firstType}" or "${kind.lastType}".`;
  const raw = await generateStructured(prompt, generateModel, itemSchema(kind), { think: false });
  let item = toItem(kind, raw);
  if ([kind.firstType, kind.lastType].includes(item[kind.typeKey])) item = { ...item, [kind.typeKey]: kind.defaultType };
  await attachSources(generation, kind, [item]);
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
    preview: row.content.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS),
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
  const candidates = kind.types.filter((t) => t !== current && t !== kind.firstType && t !== kind.lastType);
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
