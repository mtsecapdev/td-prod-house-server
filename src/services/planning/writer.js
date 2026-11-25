// Writes slides / sections from the agreed plan. Each item is written with the whole plan in view (brief,
// storyline, full outline), a one-line summary of every item already written, and its own pinned sources.
//
// Prompt order matters for scale: the system prompt and the plan block are identical for every item in a
// generation, so llama.cpp / vLLM can reuse them from their prompt cache. Item-specific text comes last.
import config from '../../config.js';
import { chatStructured, requestEmbedding } from '../llm.js';
import { getChunksByIdsDb, getSourcePassagesDb, getAllPassagesDb } from '../../db/chunksQueries.js';
import { renderWithRepair, DiagramSyntaxError } from '../diagrams.js';
import { kindOf, styleGuide, briefBlock, storylineBlock } from './kinds.js';
import { fitContent } from './fit.js';
import { stripFigureMarkers, pictureOf } from '../figures.js';
import { getFigureByIdDb } from '../../db/figuresQueries.js';
import { sourceQuery, pastedText } from './planner.js';
import { isStatValue } from './layouts.js';
import { checkWritten } from './checkWritten.js';

// Every passage of a generation's documents, for the fact check (kept briefly: items are written one after another).
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

const { generateModel } = config.ollama;
// Free-form pasted text goes into the shared plan block (identical for every item, so it is cached).
const MAX_PASTED_IN_PLAN = 12000;

// How to treat the user's own text, by the mode they chose.
const TEXT_MODES = {
  generate: 'Use the user\'s text as the starting point. You may expand it with facts from the sources.',
  condense: 'Condense the user\'s text into the layout. Keep their points and, where possible, their wording. Add nothing that is not in their text.',
  preserve: 'Keep the user\'s exact wording. Only arrange it into the layout\'s fields: do not add, remove or reword anything.',
};
const FIGURE_RE = /[€$£]?\d[\d,.]*\s?(?:%|[MBK]\b|bn\b|million\b|billion\b)?/g;

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
    `Full outline (${kind.nounPlural} in order: type | title | what it covers):\n${outlineLines}`,
  ].filter(Boolean).join('\n\n');
}

function textOf(content) {
  const out = [];
  const skip = new Set(['source_chunk_ids', 'used_pages', 'speaker_notes', 'mermaid_code', 'diagram_file', 'diagram_type']);
  (function walk(v, key) {
    if (skip.has(key)) return;
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, k));
  })(content);
  return out.join(' ');
}

/** One line per item already written, so the model builds on them instead of repeating them. */
function writtenBlock(kind, items, uptoIndex) {
  const lines = [];
  for (let i = 0; i < uptoIndex; i++) {
    const it = items[i];
    if (!it.content) continue;
    const figures = [...new Set(textOf(it.content).match(FIGURE_RE) || [])]
      .map((f) => f.trim()).filter((f) => f.length > 1).slice(0, 8);
    lines.push(`${i + 1}. ${it.content.title || it.content.statement || it.title}` +
      (figures.length ? ` Figures used: ${figures.join(', ')}.` : ''));
  }
  return lines.length ? lines.join('\n') : '(none yet)';
}

// Passages found by searching on the item's title and points, added to those it was planned with.
const SEARCHED_EXTRA = 2;

async function sourcesFor(generation, kind, item) {
  if (item.sources?.length) {
    const planned = await getChunksByIdsDb(item.sources.map((s) => s.chunk_id));
    if (kind.noSourceTypes.includes(item[kind.typeKey]) || !generation.source_document_ids?.length) {
      return { rows: planned, sources: item.sources };
    }
    // The planner sometimes attaches the wrong passages (a "Product Portfolio" slide planned from the finance and
    // sustainability pages); the best matches for what the item is about come too, so it can be written in full.
    const q = sourceQuery(item);
    const have = new Set(planned.map((r) => r.id));
    const found = (await getSourcePassagesDb(await requestEmbedding(q), SEARCHED_EXTRA + planned.length, generation.source_document_ids, q))
      .filter((r) => !have.has(r.id)).slice(0, SEARCHED_EXTRA);
    return { rows: [...planned, ...found], sources: item.sources };
  }
  if (kind.noSourceTypes.includes(item[kind.typeKey])) return { rows: [], sources: [] };
  // An item the user added or emptied in the outline: search on its title and bullets.
  const q = sourceQuery(item);
  const rows = await getSourcePassagesDb(await requestEmbedding(q), kind.sourcesPerItem, generation.source_document_ids, q);
  return {
    rows,
    sources: rows.map((r) => ({ chunk_id: r.id, page: r.page, heading: r.heading, preview: r.content.slice(0, 220), added: false })),
  };
}

async function writeAs(generation, kind, index, type, { note, figure } = {}) {
  const items = generation.outline[kind.listKey];
  const item = items[index];
  const { rows, sources } = await sourcesFor(generation, kind, item);
  const userNote = note ?? item.note;
  const bullets = (item.bullets || []).map((b) => b.trim()).filter(Boolean);

  const sourceText = rows.length
    ? rows.map((r) => `[p. ${r.page ?? '?'}${r.heading ? ` · ${r.heading}` : ''}]\n${stripFigureMarkers(r.content)}`).join('\n\n')
    : `(No sources for this ${kind.noun}: build it from the plan and the ${kind.nounPlural} already written.)`;

  const itemBlock = [
    `Write ${kind.noun} ${index + 1} of ${items.length}.`,
    `Planned title (improve it if you can): ${item.title}`,
    bullets.length ? `What it should cover:\n${bullets.map((t) => `- ${t}`).join('\n')}` : '',
    figure ? `The figure this ${kind.noun} shows: ${figure.caption || 'untitled figure'} (p. ${figure.page ?? '?'}).` +
      (figure.labels ? `\nText printed in the figure, in reading order: ${figure.labels}` : '') +
      (figure.caption ? '' : '\nThe document gives this figure no caption: write `caption` from the text printed in it only, not from the sources.') : '',
    item.own_text ? `The user's own text for this ${kind.noun}:\n\"\"\"\n${item.own_text}\n\"\"\"` : '',
    generation.brief?.source_text ? TEXT_MODES[generation.brief.text_mode] || TEXT_MODES.generate : '',
    userNote ? `Note from the user (follow it): ${userNote}` : '',
    `Type: ${type}. How to fill it: ${kind.writeGuide[type] || ''}`,
    `Do not repeat points or figures the earlier ${kind.nounPlural} already made unless this one builds on them.`,
    // Planned points the sources don't support are dropped; the slide should still be full.
    `Fill the layout's range with facts from the sources for this ${kind.noun}'s subject: if a planned point is ` +
      `not in the sources, use other facts from them instead of leaving the ${kind.noun} short.`,
    // A fact belongs to what its passage is about: the engine manual's gasoline ignition timing ended up as
    // "diesel injection timing" once. Planned points are a plan, not evidence.
    `Keep each fact with what its source passage says it is about: a passage about one engine type, system, ` +
      `product or process is not evidence about another. If the sources do not support a planned point for this ` +
      `${kind.noun}'s subject, leave the point out.`,
    `Examples in the sources stay examples: one engine's figures, or a value shown in a diagram, are never a ` +
      `specification or rule for all.`,
    `Do not add procedures, tips or advice the sources do not give, in the text, takeaways or notes.`,
    `Refer to other ${kind.nounPlural} only by what the outline above says they contain.`,
    // Notes are where the model added its own tips and pointed at the wrong slides.
    `Notes (speaker_notes / notes) explain this ${kind.noun}'s content from the sources; a question for the ` +
      `audience is fine, tips, advice or claims the sources do not give are not. For transitions use only: ` +
      `previous ${kind.noun} "${items[index - 1]?.title || '(none: this is the first)'}", next ${kind.noun} ` +
      `"${items[index + 1]?.title || '(none: this is the last)'}".`,
    `Lines starting "Text in the figure:" list the words printed in a figure; use them to understand it, never ` +
      `copy them into the text.`,
    `Sources for this ${kind.noun}:\n${sourceText}`,
  ].filter(Boolean).join('\n\n');

  const messages = [
    { role: 'system', content: systemPrompt(kind, generation) },
    {
      role: 'user',
      content:
        `PLAN\n${planBlock(kind, generation)}\n\n---\n\n` +
        `ALREADY WRITTEN\n${writtenBlock(kind, items, index)}\n\n---\n\n${itemBlock}`,
    },
  ];

  const schema = kind.schemas[type];
  const result = await chatStructured(messages, generateModel, schema, { think: true });
  const fitted = await fitContent(kind.limits[type], schema, {
    ...result,
    source_chunk_ids: rows.map((r) => r.id),
    used_pages: [...new Set(rows.map((r) => r.page).filter((p) => p != null))].sort((a, b) => a - b),
  });
  // What the item was written from: its passages, the user's own text, the figure's caption and words.
  const checkSource = [
    rows.length ? sourceText : '', item.own_text || '', pastedText(generation.brief) || '',
    figure ? `${figure.caption || ''}\n${figure.labels || ''}` : '',
  ].filter(Boolean).join('\n\n');
  const docIds = generation.source_document_ids || [];
  const content = await checkWritten(fitted, checkSource, {
    documentPassages: await documentPassages(generation),
    findMore: async (statement) => (await getSourcePassagesDb(await requestEmbedding(statement), 2, docIds, statement))
      .map((r) => `[p. ${r.page ?? '?'}]\n${stripFigureMarkers(r.content)}`).join('\n\n'),
  });
  return { content: kind.noSourceTypes.includes(type) ? content : await titleThatFits(content, kind), sources };
}

const TITLE_FORMAT = {
  type: 'object',
  properties: { fits: { type: 'boolean' }, title: { type: 'string' } },
  required: ['fits', 'title'],
};
const MAX_TITLE_WORDS = 10;

/**
 * Keeps a title true to what the item ended up saying. Titles are planned before writing, and the fact check can
 * remove what a title promised ("Board Oversight & Executive Pay" over a slide with no pay left on it).
 */
async function titleThatFits(content, kind) {
  const title = String(content?.title || '').trim();
  const body = textOf({ ...content, title: '', speaker_notes: '', notes: '' }).trim();
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

// One-line fields (a subtitle) sometimes come back with a list appended: "Intro. - Point one- Point two".
const ONE_LINE_FIELDS = ['subtitle'];
// A list is two or more "- Item" markers (one dash is a normal subtitle: "Engine basics - for new hires").
const LIST_MARKER_RE = /-\s*[A-Z]/g;

/** Keeps one-line fields to their first line, without a list tacked on. */
function oneLineFields(content) {
  if (!content) return content;
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

const MIN_KEY_STATS = 2;
const TABLE_TYPES = new Set(['comparison_table', 'reference_table']);

/**
 * Number layouts need real numbers. Stats whose value has none (",0", "Critical", a page number) are dropped;
 * too few left, and the item is written with the default layout instead, as a diagram that won't render is.
 */
async function checkStatistics(generation, kind, index, type, written, note) {
  const { content } = written;
  if (type === 'stat_focus' ? isStatValue(content.stat_value) : true) {
    if (type === 'stat_focus') return { type, ...written };
    const stats = (content.stats || []).filter((s) => isStatValue(s.value));
    if (stats.length >= MIN_KEY_STATS) return { type, ...written, content: { ...content, stats } };
  }
  console.warn(`${kind.noun} ${index + 1}: ${type} without real numbers; using ${kind.defaultType}`);
  const fallback = await writeAs(generation, kind, index, kind.defaultType, { note });
  return { type: kind.defaultType, content: fallback.content, sources: fallback.sources };
}

/**
 * Writes one item. Returns { type, content, sources }; type differs from the plan only when a diagram could not
 * be rendered and fell back.
 */
export async function writeItem(generation, index, options = {}) {
  const item = generation.outline[kindOf(generation).listKey][index];
  const written = await writeContent(generation, index, options);
  // Pictures the user placed stay through rewrites and layout changes; a figure item shows its figure first.
  const pictures = [...(item?.content?.pictures || [])];
  const { figure, ...rest } = written;
  // A figure planned beside a list goes on as a picture (decks: on a layout with a picture panel).
  const kind = kindOf(generation);
  if (!figure && item?.figure_beside && item.figure_id && (kind.name === 'doc' || kind.besideTypes.includes(written.type))) {
    const beside = await getFigureByIdDb(item.figure_id);
    if (beside && !pictures.some((p) => Number(p.figure_id) === beside.id)) pictures.push(pictureOf(beside));
  }
  if (figure) {
    // The writer's caption is only a stand-in for figures the document left uncaptioned.
    const { caption, ...content } = rest.content;
    rest.content = content;
    if (!pictures.some((p) => Number(p.figure_id) === figure.id)) pictures.unshift(pictureOf(figure, caption));
  }
  return pictures.length ? { ...rest, content: { ...rest.content, pictures } } : rest;
}

async function writeContent(generation, index, { note, type: typeOverride } = {}) {
  const kind = kindOf(generation);
  const item = generation.outline[kind.listKey][index];
  if (!item) throw new Error(`${kind.noun} ${index + 1} is not in the outline`);
  const type = kind.types.includes(typeOverride) ? typeOverride : (item[kind.typeKey] || kind.defaultType);

  if (type === 'figure') {
    const figure = item.figure_id ? await getFigureByIdDb(item.figure_id) : null;
    if (figure) return { type, figure, ...(await writeAs(generation, kind, index, type, { note, figure })) };
    // The figure was deleted: write the slide as points instead.
    const fallback = await writeAs(generation, kind, index, kind.defaultType, { note });
    return { type: kind.defaultType, ...fallback };
  }

  const written = await writeAs(generation, kind, index, type, { note });
  // A table with no rows or columns renders as nothing: write the item in the default layout instead.
  if (TABLE_TYPES.has(type) && !(written.content?.rows?.length && written.content?.columns?.length)) {
    console.warn(`${kind.noun} ${index + 1}: ${type} came back empty; using ${kind.defaultType}`);
    const fallback = await writeAs(generation, kind, index, kind.defaultType, { note });
    return { type: kind.defaultType, content: oneLineFields(distinctSubheadings(withoutPageMarks(fallback.content))), sources: fallback.sources };
  }
  const content = oneLineFields(distinctSubheadings(withoutPageMarks(written.content)));
  const { sources } = written;
  if (type === 'key_stats' || type === 'stat_focus') return checkStatistics(generation, kind, index, type, { content, sources }, note);
  if (type !== 'diagram') return { type, content, sources };

  try {
    return { type, content: await renderWithRepair(generation, content, kind.schemas.diagram), sources };
  } catch (err) {
    if (!(err instanceof DiagramSyntaxError)) throw err;
    console.warn(`${kind.noun} ${index + 1}: diagram failed to render (${err.message.split('\n')[0]}); using ${kind.diagramFallback}`);
    const fallback = await writeAs(generation, kind, index, kind.diagramFallback, { note });
    return { type: kind.diagramFallback, content: fallback.content, sources: fallback.sources };
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
