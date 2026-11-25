// Writes slides / sections from the agreed plan. Each item is written with the whole plan in view (brief,
// storyline, full outline), a one-line summary of every item already written, and its own evidence.
//
// Evidence depends on the kind of product (kinds.js writeFrom):
// - decks ('facts'): the facts the planner quoted for the slide (planning/facts.js), plus passages the user added
//   and passages for points the user wrote into the plan. The slide is written from those alone; its numbers
//   are then checked against them, and a slide that used others is written once more with them pointed out.
//   Nothing is deleted after writing, so a slide never ends up with a lone point.
// - documents ('passages'): the item's whole passages, since sections are prose; the result is fact-checked and
//   unsupported statements are removed (checkWritten.js).
//
// Prompt order matters for scale: the system prompt and the plan block are identical for every item in a
// generation, so llama.cpp / vLLM can reuse them from their prompt cache. Item-specific text comes last.
import config from '../../config.js';
import { chatStructured, requestEmbedding, requestEmbeddingBatch } from '../llm.js';
import { getChunksByIdsDb, getSourcePassagesDb, getAllPassagesDb } from '../../db/chunksQueries.js';
import { renderWithRepair, DiagramSyntaxError } from '../diagrams.js';
import { kindOf, styleGuide, briefBlock, storylineBlock } from './kinds.js';
import { fitContent } from './fit.js';
import { stripFigureMarkers, pictureOf } from '../figures.js';
import { getFigureByIdDb } from '../../db/figuresQueries.js';
import { sourceQuery, pastedText } from './planner.js';
import { checkWritten } from './checkWritten.js';
import { factsBlock } from './facts.js';
import { unsupportedNumbers, sentencesOf } from '../factCheck.js';
import { withIcons } from './icons.js';

const { generateModel } = config.ollama;
// Free-form pasted text goes into the shared plan block (identical for every item, so it is cached).
const MAX_PASTED_IN_PLAN = 12000;
// Passages found by searching on the item's title and points (documents), or on each point the user wrote
// into the plan (decks).
const SEARCHED_EXTRA = 2;

// How to treat the user's own text, by the mode they chose.
const TEXT_MODES = {
  generate: 'Use the user\'s text as the starting point. You may expand it with the facts given.',
  condense: 'Condense the user\'s text into the slide. Keep their points and, where possible, their wording. Add nothing that is not in their text.',
  preserve: 'Keep the user\'s exact wording. Only arrange it into the fields: do not add, remove or reword anything.',
};
const FIGURE_RE = /[€$£]?\d[\d,.]*\s?(?:%|[MBK]\b|bn\b|million\b|billion\b)?/g;
// Fields that are not text for the reader.
const NOT_TEXT = new Set(['source_chunk_ids', 'used_pages', 'mermaid_code', 'diagram_file', 'diagram_type', 'pictures', 'image', 'icon']);

function systemPrompt(kind, generation) {
  return (
    `You are an expert instructional designer writing one ${kind.noun} of a ${kind.product}. ` +
    `Return only JSON matching the schema.\n\n${styleGuide(kind, generation.brief)}`
  );
}

function planBlock(kind, generation) {
  const items = generation.outline[kind.listKey];
  const outlineLines = items.map((it, i) =>
    `${i + 1}. ${it[kind.typeKey]} | ${it.title} | ${(it.bullets || []).filter((b) => b.trim()).join('; ')}`).join('\n');
  const pasted = pastedText(generation.brief);
  const freeForm = pasted && !items.some((it) => it.own_text);
  return [
    `Brief:\n${briefBlock(generation)}`,
    freeForm ? `The user's own text:\n\"\"\"\n${pasted.slice(0, MAX_PASTED_IN_PLAN)}\n\"\"\"` : '',
    storylineBlock(generation.storyline),
    `Full outline (${kind.nounPlural} in order: kind | title | what it covers):\n${outlineLines}`,
  ].filter(Boolean).join('\n\n');
}

/** Every text in the content, with where it lives: [{ path, text }]. */
function textsOf(content, { notes = true } = {}) {
  const out = [];
  (function walk(v, path) {
    const key = path[path.length - 1];
    if (NOT_TEXT.has(key) || (!notes && (key === 'speaker_notes' || key === 'notes'))) return;
    if (typeof v === 'string') out.push({ path, text: v });
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, i]));
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, [...path, k]));
  })(content, []);
  return out;
}

/** One line per item already written, so the model builds on them instead of repeating them. */
function writtenBlock(kind, items, uptoIndex) {
  const lines = [];
  for (let i = 0; i < uptoIndex; i++) {
    const it = items[i];
    if (!it.content) continue;
    const figures = [...new Set(textsOf(it.content, { notes: false }).map((t) => t.text).join(' ').match(FIGURE_RE) || [])]
      .map((f) => f.trim()).filter((f) => f.length > 1).slice(0, 8);
    lines.push(`${i + 1}. ${it.content.title || it.content.statement || it.title}` +
      (figures.length ? ` Figures used: ${figures.join(', ')}.` : ''));
  }
  return lines.length ? lines.join('\n') : '(none yet)';
}

const passageText = (rows) => rows.map((r) => `[p. ${r.page ?? '?'}${r.heading ? ` · ${r.heading}` : ''}]\n${stripFigureMarkers(r.content)}`).join('\n\n');

// ── Evidence ──

/**
 * A slide's evidence: its planned facts; passages the user added (sources no fact came from); and passages for
 * points the user wrote or changed in the plan, found by search. A slide with none of these (one the user added
 * blank) gets passages found from its title.
 */
async function factEvidence(generation, kind, item, type) {
  const docIds = generation.source_document_ids || [];
  if (kind.noSourceTypes.includes(type)) {
    // The closing recaps the deck: its numbers come from every slide's facts.
    const all = type === kind.lastType ? generation.outline[kind.listKey].flatMap((it) => it.facts || []) : [];
    return { text: all.length ? `Facts in the deck:\n${factsBlock(all)}` : '', rows: [], facts: all };
  }
  const facts = item.facts || [];
  const fromFacts = new Set(facts.map((f) => f.chunk_id));
  const added = (item.sources || []).filter((s) => !fromFacts.has(s.chunk_id)).map((s) => s.chunk_id);
  const planned = new Set(facts.map((f) => f.point.trim()));
  const written = (item.bullets || []).map((b) => b.trim()).filter((b) => b && !planned.has(b));
  let queries = written;
  if (!facts.length && !added.length && !written.length && !item.own_text) queries = [sourceQuery(item)];

  const rows = await getChunksByIdsDb(added);
  if (queries.length && docIds.length) {
    const have = new Set([...rows.map((r) => r.id), ...fromFacts]);
    const vectors = await requestEmbeddingBatch(queries);
    for (let q = 0; q < queries.length; q++) {
      const found = await getSourcePassagesDb(vectors[q], SEARCHED_EXTRA + 2, docIds, queries[q]);
      for (const r of found.filter((x) => !have.has(x.id)).slice(0, SEARCHED_EXTRA)) { rows.push(r); have.add(r.id); }
    }
  }
  const text = [
    facts.length ? `Facts for this ${kind.noun}:\n${factsBlock(facts)}` : '',
    rows.length ? `Passages for this ${kind.noun}:\n${passageText(rows)}` : '',
  ].filter(Boolean).join('\n\n');
  return { text, rows, facts };
}

/** A section's evidence: its planned passages plus the best matches for what it is about. */
async function passageEvidence(generation, kind, item, type) {
  const docIds = generation.source_document_ids || [];
  if (kind.noSourceTypes.includes(type)) return { text: '', rows: [], facts: [] };
  const planned = await getChunksByIdsDb((item.sources || []).map((s) => s.chunk_id));
  let rows = planned;
  if (docIds.length) {
    // The planner sometimes attaches the wrong passages; the best matches for what the item is about come too.
    const q = sourceQuery(item);
    const have = new Set(planned.map((r) => r.id));
    const found = (await getSourcePassagesDb(await requestEmbedding(q), SEARCHED_EXTRA + Math.max(planned.length, kind.sourcesPerItem), docIds, q))
      .filter((r) => !have.has(r.id)).slice(0, planned.length ? SEARCHED_EXTRA : kind.sourcesPerItem);
    rows = [...planned, ...found];
  }
  const text = rows.length ? `Sources for this ${kind.noun}:\n${passageText(rows)}` : '';
  return { text, rows, facts: [] };
}

// Every passage of a generation's documents, for the document fact check (kept briefly: items are written one
// after another).
const passageCache = new Map();
async function documentPassages(generation) {
  const key = (generation.source_document_ids || []).join(',');
  if (!key) return [];
  if (!passageCache.has(key)) {
    passageCache.set(key, getAllPassagesDb(generation.source_document_ids));
    setTimeout(() => passageCache.delete(key), 10 * 60 * 1000).unref();
  }
  return passageCache.get(key);
}

// ── Writing ──

function itemBlock(generation, kind, index, type, { note, figure, evidence }) {
  const items = generation.outline[kind.listKey];
  const item = items[index];
  const userNote = note ?? item.note;
  const bullets = (item.bullets || []).map((b) => b.trim()).filter(Boolean);
  const facts = kind.writeFrom === 'facts';
  const noEvidence = `(No sources for this ${kind.noun}: build it from the plan and the ${kind.nounPlural} already written.)`;
  return [
    `Write ${kind.noun} ${index + 1} of ${items.length}.`,
    `Planned title (improve it if you can): ${item.title}`,
    bullets.length ? `What it should cover:\n${bullets.map((t) => `- ${t}`).join('\n')}` : '',
    figure ? `The figure this ${kind.noun} shows: ${figure.caption || 'untitled figure'} (p. ${figure.page ?? '?'}).` +
      (figure.labels ? `\nText printed in the figure, in reading order: ${figure.labels}` : '') +
      (figure.caption ? '' : '\nThe document gives this figure no caption: write `caption` from the text printed in it only.') : '',
    item.own_text ? `The user's own text for this ${kind.noun}:\n\"\"\"\n${item.own_text}\n\"\"\"` : '',
    generation.brief?.source_text ? TEXT_MODES[generation.brief.text_mode] || TEXT_MODES.generate : '',
    userNote ? `Note from the user (follow it): ${userNote}` : '',
    `Kind: ${type}. How to fill it:\n${kind.writeGuide[type] || ''}`,
    facts
      ? `Write only from the facts${evidence.rows.length ? ' and passages' : ''} below${item.own_text ? ' and the user\'s text' : ''}: ` +
        `every number, name and claim must come from them, with their exact figures. Do not add causes, ` +
        `comparisons, tips or advice they do not state. Say each fact once.`
      : `Fill the type's range with facts from the sources for this ${kind.noun}'s subject: if a planned point is ` +
        `not in the sources, use other facts from them instead of leaving it short. Do not add procedures, tips or ` +
        `advice the sources do not give.`,
    `Do not repeat points or figures the earlier ${kind.nounPlural} already made unless this one builds on them.`,
    // A fact belongs to what its passage is about: the engine manual's gasoline ignition timing ended up as
    // "diesel injection timing" once.
    `Keep each fact with what its source says it is about: a passage about one engine type, system, product or ` +
      `process is not evidence about another. Examples stay examples: one engine's figures are never a rule for all.`,
    // Notes are where the model added its own tips and pointed at the wrong slides.
    `Notes (speaker_notes / notes) explain this ${kind.noun}'s content from the same facts; a question for the ` +
      `audience is fine, tips or claims of your own are not. For transitions use only: previous ${kind.noun} ` +
      `"${items[index - 1]?.title || '(none: this is the first)'}", next ${kind.noun} ` +
      `"${items[index + 1]?.title || '(none: this is the last)'}".`,
    `Lines starting "Text in the figure:" list the words printed in a figure; use them to understand it, never ` +
      `copy them into the text.`,
    evidence.text || (kind.noSourceTypes.includes(type) ? '' : noEvidence),
  ].filter(Boolean).join('\n\n');
}

/** Texts whose numbers the evidence doesn't give: [{ path, text, numbers }]. */
function unsupportedIn(content, evidence) {
  return textsOf(content)
    .map((t) => ({ ...t, numbers: unsupportedNumbers(t.text, evidence) }))
    .filter((t) => t.numbers.length);
}

/**
 * The last word on numbers no evidence gives, after the rewrite: such sentences leave the notes, such entries
 * leave their list (a list keeps at least one entry). A slide's main text is never emptied.
 */
function withoutUnsupported(content, bad, evidence) {
  const out = structuredClone(content);
  const drop = new Map();
  for (const { path } of bad) {
    const [key, index] = path;
    if (key === 'speaker_notes' || key === 'notes') {
      out[key] = sentencesOf(out[key]).filter((s) => !unsupportedNumbers(s, evidence).length).join(' ');
    } else if (typeof index === 'number' && Array.isArray(out[key])) {
      if (!drop.has(key)) drop.set(key, new Set());
      drop.get(key).add(index);
    }
  }
  for (const [key, indexes] of drop) {
    const kept = out[key].filter((_, i) => !indexes.has(i));
    if (kept.length) out[key] = kept;
  }
  return out;
}

async function writeAs(generation, kind, index, type, { note, figure } = {}) {
  const item = generation.outline[kind.listKey][index];
  const evidence = kind.writeFrom === 'facts'
    ? await factEvidence(generation, kind, item, type)
    : await passageEvidence(generation, kind, item, type);
  const messages = [
    { role: 'system', content: systemPrompt(kind, generation) },
    {
      role: 'user',
      content:
        `PLAN\n${planBlock(kind, generation)}\n\n---\n\n` +
        `ALREADY WRITTEN\n${writtenBlock(kind, generation.outline[kind.listKey], index)}\n\n---\n\n` +
        itemBlock(generation, kind, index, type, { note, figure, evidence }),
    },
  ];
  const schema = kind.schemas[type];
  // Where the item's content comes from (shown as "From p. ..."); a closing recap draws on the whole deck, so none.
  const own = kind.noSourceTypes.includes(type) ? { facts: [], rows: [] } : evidence;
  const ids = {
    source_chunk_ids: [...new Set([...own.facts.map((f) => f.chunk_id).filter(Boolean), ...own.rows.map((r) => r.id)])],
    used_pages: [...new Set([...own.facts.map((f) => f.page), ...own.rows.map((r) => r.page)].filter((p) => p != null))].sort((a, b) => a - b),
  };
  const write = async (msgs) => fitContent(kind.limits[type], schema, { ...(await chatStructured(msgs, generateModel, schema, { think: true })), ...ids });
  let content = await write(messages);

  // What the item may draw on: its evidence, the user's own text, the figure's caption and words.
  const checkSource = [
    evidence.text, item.own_text || '', pastedText(generation.brief) || '',
    figure ? `${figure.caption || ''}\n${figure.labels || ''}` : '',
  ].filter(Boolean).join('\n\n');

  if (kind.writeFrom === 'facts') {
    let bad = unsupportedIn(content, checkSource);
    if (bad.length) {
      // Written once more with the numbers pointed out; whatever is still unsupported goes.
      content = await write([
        ...messages,
        { role: 'assistant', content: JSON.stringify({ ...content, source_chunk_ids: undefined, used_pages: undefined }) },
        {
          role: 'user',
          content: `These numbers are not in the facts: ${[...new Set(bad.flatMap((b) => b.numbers))].join(', ')}. ` +
            `Write the ${kind.noun} again using only numbers the facts state (rounding them is fine).`,
        },
      ]);
      bad = unsupportedIn(content, checkSource);
      if (bad.length) content = withoutUnsupported(content, bad, checkSource);
    }
    return { content: await withIcons(type, content), sources: item.sources || [] };
  }

  // Documents: statements the sources don't support are removed, then the title is checked against what is left.
  const checked = await checkWritten(content, checkSource, {
    documentPassages: await documentPassages(generation),
    findMore: async (statement) => (await getSourcePassagesDb(await requestEmbedding(statement), 2, generation.source_document_ids || [], statement))
      .map((r) => `[p. ${r.page ?? '?'}]\n${stripFigureMarkers(r.content)}`).join('\n\n'),
  });
  return { content: kind.noSourceTypes.includes(type) ? checked : await titleThatFits(checked, kind), sources: item.sources || [] };
}

const TITLE_FORMAT = {
  type: 'object',
  properties: { fits: { type: 'boolean' }, title: { type: 'string' } },
  required: ['fits', 'title'],
};
const MAX_TITLE_WORDS = 10;

/**
 * Keeps a section's title true to what it ended up saying: the fact check can remove what a title promised
 * ("Board Oversight & Executive Pay" over a section with no pay left in it).
 */
async function titleThatFits(content, kind) {
  const title = String(content?.title || '').trim();
  const body = textsOf({ ...content, title: '' }, { notes: false }).map((t) => t.text).join(' ').trim();
  if (!title || !body) return content;
  try {
    const result = await chatStructured([
      { role: 'system', content: `You check the title of one ${kind.noun}. Return only JSON.` },
      {
        role: 'user',
        content: `Title: ${title}\n\n${kind.noun} content:\n${body.slice(0, 3000)}\n\n` +
          `fits: true when every topic the title names is covered by the content. If not, title: a new title of ` +
          `at most ${MAX_TITLE_WORDS} words naming what the content covers, in the same style; otherwise the same title.`,
      },
    ], generateModel, TITLE_FORMAT, { think: false });
    const better = String(result.title || '').trim();
    if (result.fits !== false || !better || better.split(/\s+/).length > MAX_TITLE_WORDS) return content;
    return { ...content, title: better };
  } catch {
    return content;
  }
}

// ── Clean-up of what was written ──

// One-line fields (a subtitle) sometimes come back with a list appended: "Intro. - Point one- Point two".
const ONE_LINE_FIELDS = ['subtitle'];
// A list is two or more "- Item" markers (one dash is a normal subtitle: "Engine basics - for new hires").
const LIST_MARKER_RE = /-\s*[A-Z]/g;

function oneLineFields(content) {
  const out = { ...content };
  for (const f of ONE_LINE_FIELDS) {
    if (typeof out[f] !== 'string') continue;
    let text = out[f].split('\n')[0];
    if ((text.match(LIST_MARKER_RE) || []).length >= 2) text = text.slice(0, text.search(/\s-\s*[A-Z]/)).trim() || text;
    out[f] = text.trim();
  }
  return out;
}

// Passages mark page changes with "[p. N]" lines; they are for the model, never for the slide.
const PAGE_MARK_IN_TEXT_RE = /\s*\[p\. \d+\]/g;

function withoutPageMarks(value) {
  if (typeof value === 'string') return value.replace(PAGE_MARK_IN_TEXT_RE, '').trim();
  if (Array.isArray(value)) return value.map(withoutPageMarks);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutPageMarks(v)]));
  return value;
}

/** A subheading the model repeated is dropped, so the paragraph continues under the one before. */
function distinctSubheadings(content) {
  if (!Array.isArray(content?.paragraphs)) return content;
  const seen = new Set();
  const paragraphs = content.paragraphs.map((p) => {
    const key = String(p.subheading || '').trim().toLowerCase();
    if (!key) return p;
    if (seen.has(key)) return { ...p, subheading: '' };
    seen.add(key);
    return p;
  });
  return { ...content, paragraphs };
}

const tidy = (content) => oneLineFields(distinctSubheadings(withoutPageMarks(content)));

// A kind that came back unusable is written as the default kind instead: numbers without a number in them, a
// table without rows.
const UNUSABLE = {
  numbers: (c) => !(c.numbers || []).some((n) => /\d/.test(n.value)),
  table: (c) => !(c.rows?.length && c.columns?.length),
  reference_table: (c) => !(c.rows?.length && c.columns?.length),
};

/**
 * Writes one item. Returns { type, content, sources }; type differs from the plan only when the planned kind
 * could not be used (a diagram that won't render, numbers without numbers, an empty table).
 */
export async function writeItem(generation, index, options = {}) {
  const kind = kindOf(generation);
  const item = generation.outline[kind.listKey][index];
  const written = await writeContent(generation, index, options);
  // Pictures the user placed stay through rewrites and kind changes. A Figure item shows its figure first, under
  // the document's caption (the writer's caption is only a stand-in for an uncaptioned figure); a figure planned
  // for another kind goes on beside the text.
  const pictures = [...(item?.content?.pictures || [])];
  const { figure, ...rest } = written;
  let shown = null;
  let standIn = '';
  if (figure) {
    const { caption, ...content } = rest.content;
    rest.content = content;
    shown = figure;
    standIn = caption;
  } else if (item?.figure_id && kind.pictureTypes.includes(written.type)) {
    shown = await getFigureByIdDb(item.figure_id);
  }
  if (shown && !pictures.some((p) => Number(p.figure_id) === shown.id)) pictures.unshift(pictureOf(shown, standIn));
  return pictures.length ? { ...rest, content: { ...rest.content, pictures } } : rest;
}

async function writeContent(generation, index, { note, type: typeOverride } = {}) {
  const kind = kindOf(generation);
  const item = generation.outline[kind.listKey][index];
  if (!item) throw new Error(`${kind.noun} ${index + 1} is not in the outline`);
  const type = kind.types.includes(typeOverride) ? typeOverride : (item[kind.typeKey] || kind.defaultType);
  const fallback = async (reason, to = kind.defaultType) => {
    console.warn(`${kind.noun} ${index + 1}: ${reason}; written as ${to}`);
    const again = await writeAs(generation, kind, index, to, { note });
    return { type: to, content: tidy(again.content), sources: again.sources };
  };

  if (type === 'figure') {
    const figure = item.figure_id ? await getFigureByIdDb(item.figure_id) : null;
    if (!figure) return fallback('its figure was deleted');
    const written = await writeAs(generation, kind, index, type, { note, figure });
    return { type, figure, content: tidy(written.content), sources: written.sources };
  }

  const written = await writeAs(generation, kind, index, type, { note });
  const content = tidy(written.content);
  if (UNUSABLE[type]?.(content)) return fallback(`${type} came back without what it needs`);
  if (type === 'numbers') content.numbers = content.numbers.filter((n) => /\d/.test(n.value));
  if (type !== 'diagram') return { type, content, sources: written.sources };

  try {
    return { type, content: await renderWithRepair(generation, content, kind.schemas.diagram), sources: written.sources };
  } catch (err) {
    if (!(err instanceof DiagramSyntaxError)) throw err;
    return fallback(`diagram failed to render (${err.message.split('\n')[0]})`, kind.diagramFallback);
  }
}

/**
 * Writes, in order, every item that has no content yet (items the user left unchanged keep theirs).
 * onItemDone(items, index) runs after each one so the caller can save progress and show the finished item.
 */
export async function writeAll(generation, { onProgress, onItemDone } = {}) {
  const kind = kindOf(generation);
  const items = generation.outline[kind.listKey].map((it) => ({ ...it }));
  const working = { ...generation, outline: { ...generation.outline, [kind.listKey]: items } };

  for (let i = 0; i < items.length; i++) {
    if (items[i].content) continue;
    if (onProgress) {
      await onProgress({
        phase: kind.noun, [kind.noun]: i + 1, total: items.length, done: i,
        title: items[i].title, [kind.typeKey]: items[i][kind.typeKey],
      });
    }
    const { type, content, sources } = await writeItem(working, i);
    items[i] = { ...items[i], [kind.typeKey]: type, content, sources };
    if (onItemDone) await onItemDone(items, i);
  }
  return items;
}
