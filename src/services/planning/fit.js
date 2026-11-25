// Keeps written text inside what each layout can hold (the "smart layout" rule: content adapts to the
// layout, never spills out of it). Item counts are capped in the JSON schemas (maxItems, enforced by
// Ollama's grammar); character lengths are checked here after writing, and over-long fields are rewritten
// shorter. Text is never truncated.
import config from '../../config.js';
import { chatStructured } from '../llm.js';

// Max characters per field, by layout. Paths: "title", "bullets[].detail", "columns[]", "rows[][]".
// Sized for the slide renderer's boxes at their default font sizes (presented slides: short points; detail
// belongs in the speaker notes).
export const DECK_LIMITS = {
  title: { title: 60, subtitle: 180 },
  bullets: { title: 60, 'bullets[].heading': 36, 'bullets[].detail': 110 },
  two_column: { title: 70, column_a_heading: 40, column_b_heading: 40, 'column_a_bullets[]': 110, 'column_b_bullets[]': 110, verdict: 140 },
  stat_focus: { title: 60, stat_value: 14, stat_label: 40, context: 150 },
  key_stats: { title: 70, 'stats[].value': 14, 'stats[].label': 30, 'stats[].detail': 110 },
  quote_highlight: { title: 70, quote_text: 240, attribution: 80, commentary: 180 },
  checklist: { title: 60, 'items[].step': 45, 'items[].detail': 100 },
  closing: { title: 60, 'takeaways[]': 130, call_to_action: 140 },
  section_divider: { title: 50, subtitle: 140 },
  big_idea: { statement: 110, supporting: 180 },
  timeline: { title: 70, 'events[].date': 16, 'events[].label': 40, 'events[].detail': 110 },
  process_flow: { title: 70, 'steps[].label': 30, 'steps[].detail': 110 },
  icon_grid: { title: 70, 'items[].label': 30, 'items[].description': 110 },
  comparison_table: { title: 70, 'columns[]': 28, 'rows[][]': 60 },
  diagram: { title: 70, caption: 140 },
  figure: { title: 70, caption: 120 },
};

// Documents flow across pages, so only headings and table cells are bounded.
export const DOC_LIMITS = {
  heading: { title: 90, subtitle: 200 },
  body: { title: 90, 'paragraphs[].subheading': 60 },
  procedure: { title: 90, 'steps[].action': 80 },
  key_points: { title: 90, 'points[].label': 60 },
  reference_table: { title: 90, 'columns[]': 40, 'rows[][]': 120 },
  diagram: { title: 90, caption: 120 },
  figure: { title: 90, caption: 120 },
  summary: { title: 90 },
};

// Calls visit(value, set, label) for every string the path reaches.
function walk(obj, path, visit, label = '') {
  const [head, ...rest] = path.split('.');
  const m = head.match(/^([^[]+)((?:\[\])*)$/);
  if (!m || obj == null) return;
  const [, key, brackets] = m;
  const depth = brackets.length / 2;
  const reach = (value, d, setParent, lbl) => {
    if (d === 0) {
      if (rest.length) walk(value, rest.join('.'), visit, lbl);
      else if (typeof value === 'string') visit(value, setParent, lbl);
      return;
    }
    if (!Array.isArray(value)) return;
    value.forEach((v, i) => reach(v, d - 1, (nv) => { value[i] = nv; }, `${lbl}[${i}]`));
  };
  reach(obj[key], depth, (nv) => { obj[key] = nv; }, label ? `${label}.${key}` : key);
}

/** Fields longer than the layout allows: [{ field, length, max }]. */
export function overflows(limits, content) {
  const found = [];
  for (const [path, max] of Object.entries(limits || {})) {
    walk(content, path, (value, _set, field) => {
      if (value.length > max) found.push({ field, length: value.length, max });
    });
  }
  return found;
}

async function shortenPass(schema, content, over) {
  const { source_chunk_ids: _ids, used_pages: _pages, diagram_file: _d, ...forModel } = content;
  const shortened = await chatStructured([
    {
      role: 'system',
      content:
        'You shorten text so it fits a slide layout. Return the same JSON. Rewrite only the fields listed, each ' +
        'as a complete phrase or sentence of at most its character limit, keeping the facts and figures. Never ' +
        'end with "..." or a cut-off word. Leave every other field exactly as it is.',
    },
    {
      role: 'user',
      content: `JSON:\n${JSON.stringify(forModel, null, 2)}\n\nToo long:\n` +
        over.map((o) => `- ${o.field}: ${o.length} characters; at most ${o.max} (about ${Math.floor(o.max / 6.5)} words)`).join('\n'),
    },
  ], config.ollama.generateModel, schema, { think: false });
  return { ...content, ...shortened };
}

/**
 * Returns content that fits the layout: unchanged when it already fits; otherwise rewritten (up to two
 * passes) so the over-long fields are complete but shorter. Text is never cut off: anything still slightly
 * over is left as written, and the PPTX renderer steps the font down for that box.
 */
export async function fitContent(limits, schema, content) {
  if (!limits) return content;
  let fitted = content;
  for (let pass = 0; pass < 2; pass++) {
    const over = overflows(limits, fitted);
    if (!over.length) break;
    try {
      fitted = await shortenPass(schema, fitted, over);
    } catch (err) {
      console.warn(`Shortening pass failed (${err.message}); keeping the text as written`);
      break;
    }
  }
  return {
    ...fitted,
    source_chunk_ids: content.source_chunk_ids,
    used_pages: content.used_pages,
    ...(content.diagram_file ? { diagram_file: content.diagram_file } : {}),
  };
}
