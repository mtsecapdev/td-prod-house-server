// Removes what a written slide or document section says that its sources don't. The writer pads paragraphs
// with claims of its own ("this directly contributed to the 24.6% gross margin", "below industry averages",
// "Brandt succeeds Vercoe") and works out figures the sources never give ("growth exceeds FY2024's 8.2%");
// factCheck.js finds them, and they are cut here. Titles, labels and table cells are left alone.
import { unsupportedNumbers, numbersIn, checkStatements, keepFlags, sentencesOf } from '../factCheck.js';

// Passages from elsewhere in the document added as evidence, at most (characters).
const MAX_EXTRA_CHARS = 12000;
// A sentence that only makes sense after the one before it.
const REFERS_BACK_RE = /^(this|these|that|those|it|its|they|such|the (improvement|increase|decrease|decline|shortfall|change|result|growth))\b/i;

// Prose checked sentence by sentence against the sources.
const CHECKED = new Set(['text', 'detail', 'description', 'introduction', 'summary', 'key_takeaway', 'supporting',
  'context', 'commentary', 'verdict', 'caption', 'caution', 'statement']);
// Lists of one-line statements, checked item by item.
const CHECKED_LISTS = new Set(['takeaways', 'recap_points', 'column_a_bullets', 'column_b_bullets', 'bullets', 'checklist']);
// Speaker notes, next steps and calls to action also hold transitions, questions and advice the brief asks for:
// only their numbers are checked.
const NUMBERS_ONLY = new Set(['speaker_notes', 'notes', 'next_steps', 'call_to_action', 'subtitle']);
// An entry of these lists is dropped when its prose is: a bullet or point without its detail says nothing.
const DROP_WHEN_EMPTY = { paragraphs: 'text', bullets: 'detail', points: 'description', items: 'description' };

/** Every checkable piece of text in the content, with where it lives. */
function collect(content) {
  const pieces = [];
  (function walk(value, path) {
    const key = path[path.length - 1];
    if (typeof value === 'string') {
      if (CHECKED.has(key)) sentencesOf(value).forEach((s, i) => pieces.push({ path, sentence: i, text: s, model: true }));
      else if (NUMBERS_ONLY.has(key)) sentencesOf(value).forEach((s, i) => pieces.push({ path, sentence: i, text: s, model: false }));
      else if (typeof path[path.length - 1] === 'number' && CHECKED_LISTS.has(path[path.length - 2])) {
        pieces.push({ path, sentence: null, text: value, model: true });
      }
      return;
    }
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...path, i]));
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (['source_chunk_ids', 'used_pages', 'pictures', 'mermaid_code', 'rows', 'columns'].includes(k)) continue;
        walk(v, [...path, k]);
      }
    }
  })(content, []);
  return pieces;
}

function getAt(obj, path) { return path.reduce((o, k) => o?.[k], obj); }
function setAt(obj, path, value) { getAt(obj, path.slice(0, -1))[path[path.length - 1]] = value; }

/**
 * Returns the content without statements its sources don't support. source: the text the item was written from
 * (passages, the user's own text, a figure's caption and words). Content without a source is returned unchanged.
 */
export async function checkWritten(content, source, { documentPassages = [], findMore } = {}) {
  if (!source?.trim() || !content) return content;
  const pieces = collect(content);
  // An item is written from a few passages but also from its plan, which drew on the whole document: a figure
  // missing from its passages may be on another page (the workforce numbers of a "People" section). The
  // passages that hold such figures are added to the source, so the check judges them on evidence.
  let extra = '';
  for (const p of pieces) {
    const missing = unsupportedNumbers(p.text, source + extra);
    if (!missing.length) continue;
    const holder = documentPassages
      .map((d) => ({ d, hits: missing.filter((n) => numbersIn(d.content).has(n)).length }))
      .filter((x) => x.hits).sort((a, b) => b.hits - a.hits)[0];
    if (holder && extra.length < MAX_EXTRA_CHARS) extra += `\n\n[p. ${holder.d.page ?? '?'}]\n${holder.d.content}`;
  }
  source += extra;
  if (process.env.CHECK_DEBUG) console.error(`[check] source ${source.length} chars (${extra.length} added from the document)`);
  // Numbers first (exact, free); the model checks the rest.
  for (const p of pieces) p.keep = !unsupportedNumbers(p.text, source).length;
  const toAsk = pieces.filter((p) => p.keep && p.model);
  if (toAsk.length) {
    const [verdicts] = await checkStatements([{ source, statements: toAsk.map((p) => p.text) }], { findMore });
    keepFlags(verdicts).forEach((k, i) => { toAsk[i].keep = k; toAsk[i].verdict = verdicts[i]; });
  }
  if (process.env.CHECK_DEBUG) {
    for (const p of pieces.filter((x) => !x.keep)) console.error(`[check] drop (${unsupportedNumbers(p.text, source).join(',') || 'model'}) ev=${JSON.stringify(p.verdict?.evidence ?? null)}: ${p.text.slice(0, 120)}`);
  }
  if (pieces.every((p) => p.keep)) return content;
  // Never strip an item bare: if nothing would be left of its checked text, keep it as written.
  if (!pieces.filter((p) => p.model).some((p) => p.keep)) return content;

  const out = structuredClone(content);
  // Sentences: rebuild each field from the sentences kept.
  const byField = new Map();
  for (const p of pieces.filter((x) => x.sentence !== null)) {
    const key = JSON.stringify(p.path);
    if (!byField.has(key)) byField.set(key, { path: p.path, kept: [], lastDropped: false });
    const field = byField.get(key);
    // "This contributed to..." after a removed sentence points at nothing: it goes too.
    const orphan = field.lastDropped && REFERS_BACK_RE.test(p.text);
    if (p.keep && !orphan) field.kept.push(p.text);
    field.lastDropped = !p.keep || orphan;
  }
  for (const { path, kept } of byField.values()) setAt(out, path, kept.join(' '));
  // List items: remove those not kept (from the end, so indexes stay valid).
  const dropped = pieces.filter((p) => p.sentence === null && !p.keep).map((p) => p.path)
    .sort((a, b) => b[b.length - 1] - a[a.length - 1]);
  for (const path of dropped) {
    const list = getAt(out, path.slice(0, -1));
    if (list.length > 1) list.splice(path[path.length - 1], 1);
  }
  // Entries left without their prose (a paragraph with no sentences, a bullet without its detail) go, unless
  // that would empty the list.
  for (const [listKey, field] of Object.entries(DROP_WHEN_EMPTY)) {
    const list = out[listKey];
    if (!Array.isArray(list) || !list.some((e) => e && typeof e === 'object')) continue;
    const left = list.filter((e) => !(e && typeof e === 'object' && field in e && !String(e[field]).trim()));
    if (left.length) out[listKey] = left;
  }
  return out;
}
