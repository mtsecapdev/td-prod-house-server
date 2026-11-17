// Planning stages for decks and documents: clarifying questions, storyline, outline (with sources per item).
// Each stage reads the document map (overviews + section summaries stored at ingestion), not a handful of
// search hits, so the plan can cover the whole of the source documents.
import { randomBytes } from 'node:crypto';
import config from '../../config.js';
import { generateStructured, requestEmbedding, requestEmbeddingBatch } from '../llm.js';
import { getDocumentMapDb, getSourcePassagesDb } from '../../db/chunksQueries.js';
import { kindOf, briefBlock, storylineBlock } from './kinds.js';

const { generateModel } = config.ollama;
const PREVIEW_CHARS = 220;

export function newItemId(kind) {
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
  lines.push('Sections (id, page, heading: summary):');
  for (const s of sections) {
    lines.push(`- [${s.id}] p.${s.page ?? '?'} ${s.heading}: ${s.content.replace(/\s+/g, ' ').trim()}`);
  }
  return lines.join('\n');
}

// ── 1. Clarifying questions ──

const questionsSchema = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          why: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
        },
        required: ['question', 'why', 'options'],
      },
    },
  },
  required: ['questions'],
};

export async function generateQuestions(generation) {
  const kind = kindOf(generation);
  const map = await documentMap(generation);

  const prompt =
    `You are helping someone plan a ${kind.product} from their documents. Before anything is written, ` +
    `ask the few questions whose answers would most change what goes into it.\n\n` +
    `Brief:\n${briefBlock(generation)}\n\n` +
    `What the documents contain:\n${mapBlock(map)}\n\n` +
    `Rules:\n` +
    `- Ask 0-5 questions. Ask fewer when the brief is already clear. Never ask what the brief already answers.\n` +
    `- Ask about content and emphasis: which topics to focus on, what the audience must be able to do, ` +
    `which examples or figures matter, what depth. Do not ask about visual design, fonts or file format.\n` +
    `- question: short and specific to these documents, naming the topics they actually cover.\n` +
    `- why: one short line telling the user why the answer matters.\n` +
    `- options: 2-4 likely answers grounded in the documents (name sections, programmes, figures). ` +
    `The user can also type their own. Do not quote page numbers.`;

  const result = await generateStructured(prompt, generateModel, questionsSchema, { think: false });
  return (result.questions || []).slice(0, 5).map((q) => ({
    question: q.question,
    why: q.why,
    options: (q.options || []).slice(0, 4),
    answer: '',
  }));
}

// ── 2. Storyline ──

const storylineSchema = {
  type: 'object',
  properties: {
    thesis: { type: 'string' },
    arc: { type: 'string' },
    messages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          section_ids: { type: 'array', items: { type: 'integer' } },
        },
        required: ['text', 'section_ids'],
      },
    },
    out_of_scope: {
      type: 'array',
      items: {
        type: 'object',
        properties: { section: { type: 'string' }, reason: { type: 'string' } },
        required: ['section', 'reason'],
      },
    },
  },
  required: ['thesis', 'arc', 'messages', 'out_of_scope'],
};

export async function generateStoryline(generation, { instruction } = {}) {
  const kind = kindOf(generation);
  const map = await documentMap(generation);
  const [min, max] = kind.messageCounts[generation.brief?.length] || kind.messageCounts.standard;
  const current = generation.storyline;

  const revising = instruction && current?.messages?.length;
  const prompt =
    `You are planning a ${kind.product}. Decide what it argues before any ${kind.noun} is written.\n\n` +
    `Brief:\n${briefBlock(generation)}\n\n` +
    `What the documents contain:\n${mapBlock(map)}\n\n` +
    (revising
      ? `Current storyline:\n${storylineBlock(current)}\n\nThe user asks: "${instruction}"\n` +
        `Revise the storyline to do what they ask. Keep everything their request does not mention.\n\n`
      : '') +
    `Produce:\n` +
    `- thesis: the one sentence the ${kind.name === 'deck' ? 'audience' : 'reader'} should leave with, specific to these documents.\n` +
    `- arc: the shape of the argument in a few words, e.g. "situation -> problem -> response -> what you do".\n` +
    `- messages: ${min}-${max} key messages in the order they should be told. Each is one sentence that makes a ` +
    `claim (not a topic label) and lists the ids of the document sections that support it. Every message makes a ` +
    `different claim; never two messages about the same example, incident or figure.\n` +
    `- out_of_scope: sections of the documents that are relevant-sounding but deliberately left out, each with a short reason. ` +
    `Leave it empty if nothing notable is excluded.\n` +
    `Serve the brief's purpose. Use only what the documents contain.`;

  const result = await generateStructured(prompt, generateModel, storylineSchema, { think: true });

  const byId = new Map(map.sections.map((s) => [s.id, s]));
  return {
    thesis: result.thesis,
    arc: result.arc,
    messages: (result.messages || []).map((m, i) => {
      const ids = [...new Set((m.section_ids || []).filter((id) => byId.has(id)))];
      return {
        id: `m${i + 1}`,
        text: m.text,
        section_ids: ids,
        // For display: which parts of the documents back this message.
        sections: ids.map((id) => ({ id, heading: byId.get(id).heading, page: byId.get(id).page })),
      };
    }),
    out_of_scope: result.out_of_scope || [],
    generated_at: new Date().toISOString(),
  };
}

// ── 3. Outline ──

function outlineSchema(kind) {
  return {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            locked_id: { type: 'string' },
            message_id: { type: 'string' },
            title: { type: 'string' },
            point: { type: 'string' },
            talking_points: { type: 'array', items: { type: 'string' } },
            type: { type: 'string', enum: kind.types },
            type_reason: { type: 'string' },
          },
          required: ['message_id', 'title', 'point', 'talking_points', 'type', 'type_reason'],
        },
      },
    },
    required: ['items'],
  };
}

function outlineItemsBlock(kind, items) {
  return items.map((it, i) =>
    `${i + 1}. [${it.id}]${it.locked ? ' (locked)' : ''} ${it[kind.typeKey]} | ${it.title} | ${it.point || it.intent || ''}`,
  ).join('\n');
}

export async function generateOutline(generation, { instruction } = {}) {
  const kind = kindOf(generation);
  const storyline = generation.storyline;
  if (!storyline?.messages?.length) throw new Error('Create the storyline first');

  const map = await documentMap(generation);
  const inScope = new Set(storyline.messages.flatMap((m) => m.section_ids));
  const [min, max] = kind.counts[generation.brief?.length] || Object.values(kind.counts)[1];

  const existing = generation.outline?.[kind.listKey] || [];
  const locked = existing.filter((it) => it.locked);

  const typeLines = kind.types.map((t) => `- "${t}": ${kind.typeGuide[t]}`).join('\n');
  const prompt =
    `You are outlining a ${kind.product}. The storyline is agreed; now plan each ${kind.noun}.\n\n` +
    `Brief:\n${briefBlock(generation)}\n\n` +
    `Storyline:\n${storylineBlock(storyline)}\n\n` +
    `Sections the storyline draws on:\n${mapBlock(map, { onlySectionIds: inScope.size ? inScope : undefined })}\n\n` +
    (instruction && existing.length
      ? `Current outline (id, type, title, point):\n${outlineItemsBlock(kind, existing)}\n\n` +
        `The user asks: "${instruction}"\nRevise the outline to do what they ask; keep what the request does not mention.\n\n`
      : '') +
    (locked.length
      ? `These ${kind.nounPlural} are locked by the user. Include each exactly once, as an item with only ` +
        `locked_id set to its id (other fields may be empty), in the position that suits the storyline:\n` +
        `${outlineItemsBlock(kind, locked)}\n\n`
      : '') +
    `${kind.noun[0].toUpperCase() + kind.noun.slice(1)} types and what each is for:\n${typeLines}\n\n` +
    `For each ${kind.noun} give:\n` +
    `- message_id: the key message it serves (m1, m2, ...), or "" for the first and last ${kind.nounPlural}.\n` +
    `- title: specific to its content (max 10 words). No generic titles such as "Introduction" or "Key points".\n` +
    `- point: the one claim this ${kind.noun} makes, in one sentence.\n` +
    `- talking_points: 2-4 short lines on what it covers.\n` +
    `- type: the type whose purpose matches what this ${kind.noun}'s point and evidence contain: a sequence of steps, ` +
    `a comparison, several related figures, a process with decisions, dated events, and so on. Use "${kind.defaultType}" ` +
    `when nothing more specific fits, not by default.\n` +
    `- type_reason: a few words on why that type fits.\n\n` +
    `Rules:\n` +
    `- ${min}-${max} ${kind.nounPlural} in total. The first is "${kind.firstType}" and the last is "${kind.lastType}"; ` +
    `no other ${kind.noun} uses those two types.\n` +
    `- Follow the order of the key messages. Every message gets at least one ${kind.noun}.\n` +
    `- Each ${kind.noun} makes a different point; no two cover the same ground.\n` +
    `- Use only what the documents contain.`;

  const result = await generateStructured(prompt, generateModel, outlineSchema(kind), { think: true });

  // Rebuild the list: locked items come back as references; unlisted locked items keep their old position.
  const lockedById = new Map(locked.map((it) => [it.id, it]));
  const used = new Set();
  let items = [];
  for (const raw of result.items || []) {
    if (raw.locked_id && lockedById.has(raw.locked_id) && !used.has(raw.locked_id)) {
      items.push(lockedById.get(raw.locked_id));
      used.add(raw.locked_id);
      continue;
    }
    if (!raw.title) continue;
    items.push({
      id: newItemId(kind),
      message_id: raw.message_id || '',
      title: raw.title,
      point: raw.point,
      talking_points: (raw.talking_points || []).slice(0, 5),
      [kind.typeKey]: kind.types.includes(raw.type) ? raw.type : kind.defaultType,
      type_reason: raw.type_reason || '',
      sources: [],
      note: '',
      locked: false,
      content: null,
    });
  }
  for (const it of locked) {
    if (used.has(it.id)) continue;
    const at = Math.min(existing.indexOf(it), items.length);
    items.splice(at, 0, it);
  }
  items = enforceBookends(kind, items);

  await attachSources(generation, kind, items);
  return { [kind.listKey]: items, stale: false, generated_at: new Date().toISOString() };
}

// First and last item types are fixed (title/closing, heading/summary); the model occasionally drifts.
function enforceBookends(kind, items) {
  return items.map((it, i) => {
    if (it.locked) return it;
    const t = it[kind.typeKey];
    if (i === 0 && t !== kind.firstType) return { ...it, [kind.typeKey]: kind.firstType, message_id: '' };
    if (i === items.length - 1 && items.length > 1 && t !== kind.lastType) return { ...it, [kind.typeKey]: kind.lastType, message_id: '' };
    if (i > 0 && i < items.length - 1 && (t === kind.firstType || t === kind.lastType)) return { ...it, [kind.typeKey]: kind.defaultType };
    return it;
  });
}

export function sourceQuery(item) {
  return [item.title, item.point || item.intent, ...(item.talking_points || [])].filter(Boolean).join('. ');
}

function toSource(row, pinned = false) {
  return {
    chunk_id: row.id,
    page: row.page,
    heading: row.heading,
    preview: row.content.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS),
    pinned,
  };
}

/**
 * Finds sources for every item that needs them, in one embedding batch. Pinned sources stay; the rest of the
 * slots are filled by search on the item's title, point and talking points.
 */
export async function attachSources(generation, kind, items) {
  const needing = items.filter((it) =>
    !it.locked && !kind.noSourceTypes.includes(it[kind.typeKey]) &&
    (it.sources || []).filter((s) => s.pinned).length < kind.sourcesPerItem);
  if (!needing.length) return items;

  const queries = needing.map(sourceQuery);
  const embeddings = await requestEmbeddingBatch(queries);
  for (let i = 0; i < needing.length; i++) {
    const it = needing[i];
    const pinned = (it.sources || []).filter((s) => s.pinned);
    const taken = new Set(pinned.map((s) => s.chunk_id));
    const rows = await getSourcePassagesDb(embeddings[i], kind.sourcesPerItem * 2, generation.source_document_ids, queries[i]);
    const found = rows.filter((r) => !taken.has(r.id)).slice(0, kind.sourcesPerItem - pinned.length).map((r) => toSource(r));
    it.sources = [...pinned, ...found];
  }
  return items;
}

/** Search the generation's documents for passages to pin (outline "find other sources"). */
export async function searchSources(generation, q, limit = 8) {
  const embedding = await requestEmbedding(q);
  const rows = await getSourcePassagesDb(embedding, limit, generation.source_document_ids, q);
  return rows.map((r) => toSource(r));
}
