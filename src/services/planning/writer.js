// Writes slides / sections from the agreed plan. Each item is written with the whole plan in view (brief,
// storyline, full outline), a one-line summary of every item already written, and its own pinned sources.
//
// Prompt order matters for scale: the system prompt and the plan block are identical for every item in a
// generation, so llama.cpp / vLLM can reuse them from their prompt cache. Item-specific text comes last.
import config from '../../config.js';
import { chatStructured, requestEmbedding } from '../llm.js';
import { getChunksByIdsDb, getSourcePassagesDb } from '../../db/chunksQueries.js';
import { renderWithRepair, DiagramSyntaxError } from '../diagrams.js';
import { kindOf, styleGuide, briefBlock, storylineBlock } from './kinds.js';
import { fitContent } from './fit.js';
import { stripFigureMarkers, pictureOf } from '../figures.js';
import { getFigureByIdDb } from '../../db/figuresQueries.js';
import { sourceQuery, pastedText } from './planner.js';

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

async function sourcesFor(generation, kind, item) {
  if (item.sources?.length) return { rows: await getChunksByIdsDb(item.sources.map((s) => s.chunk_id)), sources: item.sources };
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
  const content = await fitContent(kind.limits[type], schema, {
    ...result,
    source_chunk_ids: rows.map((r) => r.id),
    used_pages: [...new Set(rows.map((r) => r.page).filter((p) => p != null))].sort((a, b) => a - b),
  });
  return { content, sources };
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

  const { content, sources } = await writeAs(generation, kind, index, type, { note });
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
