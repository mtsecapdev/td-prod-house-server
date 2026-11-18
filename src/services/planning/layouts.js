// Picks each slide's/section's layout from its content.
//
// The model is asked a narrow question per item, "what is this content?" (a set of points, headline numbers,
// actions, dated events, a quotation...), and code maps that answer to a layout (kind.shapes). Code then checks
// the evidence a layout needs (a Quote needs a quotation in the sources, a Timeline needs dates, Key Stats
// needs numbers) and falls back to the default layout when it is missing. Choosing among 15 layouts directly,
// the model picked layouts whose requirements it could not see (a "lessons learned" slide as a Quote).
import config from '../../config.js';
import { generateStructured } from '../llm.js';
import { getChunksByIdsDb } from '../../db/chunksQueries.js';

const { generateModel } = config.ollama;

// Layouts the user asked for by name in their request or instructions. They are requirements.
const REQUEST_PATTERNS = {
  diagram: /\b(diagrams?|mermaid|flow ?charts?|flow diagrams?|process maps?|org charts?|mind ?maps?)\b/i,
  timeline: /\btimelines?\b/i,
  comparison_table: /\b(comparison tables?|tables?)\b/i,
  reference_table: /\btables?\b/i,
  key_stats: /\b(key (stats|figures|numbers)|kpis?|statistics|metrics)\b/i,
  process_flow: /\bprocess flows?\b/i,
  procedure: /\b(procedures?|step[- ]by[- ]step)\b/i,
};

export function requestedTypes(kind, brief = {}) {
  const text = `${brief.topic || ''}\n${brief.instructions || ''}`;
  return kind.types.filter((t) => REQUEST_PATTERNS[t]?.test(text));
}

// ── Evidence checks ──

const HAS_NUMBER = /\d/;
const HAS_DATE = /\b(19|20)\d{2}\b|\bQ[1-4]\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|\bFY\s?\d{2,4}\b/i;
const QUOTATION = /["“][^"”]{25,}["”]/;
const SPOKEN_SOURCE = /\b(letter|message|statement|foreword|interview|speech|remarks)\b/i;
const ACTION_VERBS = new Set(('approve review check confirm ensure monitor track flag escalate submit complete verify prepare ' +
  'schedule set assign report update train contact record use apply identify prioritise prioritize implement establish ' +
  'secure reduce increase start stop align endorse support agree decide invest launch open hire plan measure document ' +
  'communicate share follow maintain inspect test create define deliver adopt build allocate fund commit accelerate ' +
  'expand strengthen protect close run call log quarantine notify request book read note keep raise').split(' '));

function count(bullets, re) {
  return bullets.filter((b) => re.test(b)).length;
}

function startsWithVerb(bullet) {
  const first = bullet.trim().replace(/^[^a-z]+/i, '').split(/\s+/)[0]?.toLowerCase() || '';
  return ACTION_VERBS.has(first);
}

/** Whether an item's content has what a layout needs. `passages` are its sources' full text. */
function hasEvidence(layout, item, passages) {
  const b = item.bullets || [];
  switch (layout) {
    case 'key_stats': return count(b, HAS_NUMBER) >= 3;
    case 'stat_focus': return count(b, HAS_NUMBER) >= 1;
    case 'timeline': return count(b, HAS_DATE) >= 3;
    case 'checklist':
    case 'procedure': return b.length >= 3 && b.filter(startsWithVerb).length >= Math.ceil(b.length / 2);
    case 'quote_highlight': return passages.some((p) => QUOTATION.test(p.content) || SPOKEN_SOURCE.test(p.heading || ''));
    case 'comparison_table':
    case 'reference_table': return b.length >= 3;
    case 'icon_grid': return b.length >= 3 && b.length <= 6;
    case 'two_column': return b.length >= 2;
    default: return true;
  }
}

// ── Classification ──

/** Classifies each item's content and maps it to a layout that its evidence supports. */
export async function chooseLayouts(generation, kind, items) {
  const shapes = kind.shapes;
  const names = Object.keys(shapes);
  const prompt =
    `For each ${kind.noun} below, say what its content is. Judge by what the points actually are, not by the ` +
    `title or by how interesting a layout would look.\n\n` +
    items.map((it, i) => `${i + 1}. ${it.title}\n${(it.bullets || []).map((x) => `   - ${x}`).join('\n')}`).join('\n') +
    `\n\nKinds of content:\n${names.map((n) => `- "${n}": ${shapes[n].what}`).join('\n')}\n\n` +
    `Most ${kind.nounPlural} are "points": reasons, facts or arguments, even when they mention a figure. But when ` +
    `the points are mostly figures, choose a numbers kind; when they are steps, dates or a comparison, choose that. ` +
    `Also give alt_shape: the next-best kind for the same content, different from shape. When shape is ` +
    `"points", name the other kind that would present it best (e.g. headline_numbers when it has several figures, ` +
    `sequence when it has stages); use "points" only when nothing else could work. alt_reason: a few words. ` +
    `Answer for every ${kind.noun} in order; n is its number. ` +
    `reason: a few words a user would understand, e.g. "Four figures side by side".`;
  const schema = {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        minItems: items.length,
        maxItems: items.length,
        items: {
          type: 'object',
          properties: {
            n: { type: 'integer' },
            shape: { type: 'string', enum: names },
            reason: { type: 'string' },
            alt_shape: { type: 'string', enum: names },
            alt_reason: { type: 'string' },
          },
          required: ['n', 'shape', 'reason', 'alt_shape', 'alt_reason'],
        },
      },
    },
    required: ['items'],
  };
  const [result, passagesByItem] = await Promise.all([
    generateStructured(prompt, generateModel, schema, { think: false }),
    Promise.all(items.map((it) => getChunksByIdsDb((it.sources || []).map((s) => s.chunk_id)))),
  ]);

  // Matched by number, not position: the model occasionally skips an item, which shifted every later answer.
  const byNumber = new Map((result.items || []).map((a) => [a.n, a]));
  const supported = (shape, i) => {
    const layout = shapes[shape]?.layout;
    return layout && (layout === kind.defaultType || hasEvidence(layout, items[i], passagesByItem[i])) ? layout : null;
  };
  const chosen = items.map((it, i) => {
    const answer = byNumber.get(i + 1);
    const layout = supported(answer?.shape, i) || kind.defaultType;
    const alt = supported(answer?.alt_shape, i);
    return {
      item: { ...it, [kind.typeKey]: layout, type_reason: layout === kind.defaultType ? 'A set of points' : answer?.reason || '' },
      alt: alt && alt !== kind.defaultType && alt !== layout ? { layout: alt, reason: answer.alt_reason || '' } : null,
    };
  });
  return balance(kind, chosen);
}

// Real outlines mix several facts per bullet, so most items classify as "points" and a deck can come out as
// one bullet slide after another. When more than half of the middle items are on the default layout, items
// are moved to their second-best kind (only where its evidence check passed, at most twice per layout, never
// next to the same layout) until half are.
function balance(kind, chosen) {
  const items = chosen.map((c) => c.item);
  const middle = items.length > 2 ? items.slice(1, -1) : items;
  const isDefault = (it) => it[kind.typeKey] === kind.defaultType;
  const uses = {};
  items.forEach((it) => { uses[it[kind.typeKey]] = (uses[it[kind.typeKey]] || 0) + 1; });

  let defaults = middle.filter(isDefault).length;
  for (let i = 1; i < items.length - 1 && defaults > Math.floor(middle.length / 2); i++) {
    const { alt } = chosen[i];
    if (!alt || !isDefault(items[i]) || (uses[alt.layout] || 0) >= 2) continue;
    if (items[i - 1][kind.typeKey] === alt.layout || items[i + 1]?.[kind.typeKey] === alt.layout) continue;
    items[i] = { ...items[i], [kind.typeKey]: alt.layout, type_reason: alt.reason };
    uses[alt.layout] = (uses[alt.layout] || 0) + 1;
    defaults--;
  }
  return items;
}

// ── Rules applied after choosing ──

// The first and last types are fixed (title/closing, heading/summary), and section dividers only make sense in
// long decks (10+ slides): in shorter ones they replace a content slide with a heading.
function cleanTypes(kind, items) {
  return items.map((it, i) => {
    const t = it[kind.typeKey];
    const last = i === items.length - 1 && items.length > 1;
    if (i === 0) return { ...it, [kind.typeKey]: kind.firstType };
    if (last) return { ...it, [kind.typeKey]: kind.lastType };
    if (t === kind.firstType || t === kind.lastType || (t === 'section_divider' && items.length < 10)) {
      return { ...it, [kind.typeKey]: kind.defaultType };
    }
    return it;
  });
}

// No specialised layout more than twice (unless the user asked for it): extra uses fall back to the default.
function capRepeats(kind, brief, items) {
  const wanted = new Set(requestedTypes(kind, brief));
  const seen = {};
  return items.map((it) => {
    const t = it[kind.typeKey];
    if (t === kind.defaultType || t === kind.firstType || t === kind.lastType || wanted.has(t)) return it;
    seen[t] = (seen[t] || 0) + 1;
    return seen[t] > 2 ? { ...it, [kind.typeKey]: kind.defaultType, type_reason: 'A set of points' } : it;
  });
}

// Every layout the user asked for appears at least once (replacing a middle default-layout item).
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

/** Bookends, repeat cap and requested layouts, applied to a whole outline after choosing. */
export function finishLayouts(kind, brief, items) {
  return ensureRequestedTypes(kind, brief, capRepeats(kind, brief, cleanTypes(kind, items)));
}
