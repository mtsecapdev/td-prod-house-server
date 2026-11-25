// The planning interview: before a deck or training document is planned, the assistant asks a few guiding
// questions in the chat, one at a time (who it's for, the goal, what to cover, length, how it's used, anything
// else). Answers already given in the chat are filled in and not asked. A typed answer is judged by the model; a
// vague one gets a sharper follow-up with suggestions, at most twice, then the best reading is used and said so.
// "Just make it" fills in the rest. A summary card closes the interview, and only confirming it plans the outline.
//
// The interview's state travels in its messages (data.interview), so it survives reloads and needs no table.
import config from '../config.js';
import { generateStructured } from './llm.js';
import { briefFromConversation, fullCoverageCount } from './skills.js';
import { KINDS } from './planning/kinds.js';
import { getAllPassagesDb, countSectionsDb, getDocumentOverviewsDb } from '../db/chunksQueries.js';
import { splitIntoSections } from './wholeDocument.js';

export const SLOTS = ['audience', 'goal', 'coverage', 'length', 'format', 'extras'];
const MAX_FOLLOW_UPS = 2;
const MAX_PARTS = 30;
const EVERYTHING = 'Everything';

const LENGTHS = {
  deck: { short: ['Short', 6, 'about 6 slides'], standard: ['Standard', 10, 'about 10 slides'] },
  doc: { short: ['Short', 4, 'about 4 sections'], standard: ['Standard', 6, 'about 6 sections'] },
};
const FORMATS = {
  deck: { presented: 'Presented live', read: 'Read on its own', both: 'Presented, then shared' },
  doc: { learning: 'Learning guide', reference: 'Reference', procedure: 'Procedure' },
};
const FORMAT_HINTS = {
  learning: 'read start to finish', reference: 'looked up when needed', procedure: 'followed step by step',
  presented: 'a speaker talks over it', read: 'makes sense without a speaker', both: 'presented, then sent round',
};

function question(slot, type) {
  const product = KINDS[type].product;
  const noun = type === 'deck' ? 'slides' : 'sections';
  return {
    audience: { text: `Who is this ${product} for?`, suggestions: ['New hires', 'Experienced technicians', 'Supervisors and managers'] },
    goal: {
      text: `What should they know or be able to do afterwards?`,
      suggestions: ['Understand how it works', 'Follow the procedure correctly', 'Know the key facts and figures'],
    },
    coverage: { text: `Which parts of the documents should it cover?`, multi: true },
    length: {
      text: 'How long should it be?',
      suggestions: [
        ...Object.values(LENGTHS[type]).map(([label, , hint]) => `${label} (${hint})`),
        `Full coverage (about one of the ${noun} per main part)`,
      ],
    },
    format: {
      text: type === 'deck' ? 'How will it be used?' : 'What kind of document should it be?',
      suggestions: Object.entries(FORMATS[type]).map(([key, label]) => `${label} (${FORMAT_HINTS[key]})`),
    },
    extras: { text: 'Anything to include, stress or avoid?', suggestions: ['Nothing else'] },
  }[slot];
}

const HEADING_LINE_RE = /^#{1,6}\s+(.+)$/m;
const SUBSECTION_RE = /^\d{1,2}\.\d{1,2}(?:\.0)?\s+\S/; // "1.2 Title", "1.2.0 Title"
// Fewer chapters than this is too coarse a choice: the subsections are offered instead.
const MIN_PARTS = 6;

/**
 * The parts a user can choose to cover: a document's own top-level sections (named after their first heading when
 * they have no title of their own), or its subsections when it has only a few chapters; for several documents,
 * the documents themselves.
 */
async function coverageOptions(docIds) {
  if (!docIds?.length) return [];
  if (docIds.length > 1) return (await getDocumentOverviewsDb(docIds)).map((d) => d.name.replace(/\.[a-z0-9]+$/i, ''));
  const passages = await getAllPassagesDb(docIds);
  const sections = splitIntoSections(passages)
    .filter((s) => s.key !== 'front') // the title page and contents
    .map((s) => s.title || s.pieces.map((p) => p.text.match(HEADING_LINE_RE)?.[1]).find(Boolean))
    .filter(Boolean);
  if (sections.length >= MIN_PARTS) return [...new Set(sections)].slice(0, MAX_PARTS);
  const headings = [...new Set(passages.map((p) => String(p.heading || '').trim()).filter(Boolean))];
  const sub = headings.filter((h) => SUBSECTION_RE.test(h));
  // A short list of subsections misses topics filed one level down ("2.1.4 Fuel Injection System Design").
  const numbered = headings.filter((h) => /^\d{1,2}(\.\d{1,2}){1,3}\s+\S/.test(h));
  const best = sub.length >= 10 ? sub : numbered.length >= MIN_PARTS ? numbered : sub.length >= MIN_PARTS ? sub : sections;
  return best.slice(0, MAX_PARTS);
}

// ── Starting ──

/**
 * Starts the interview for a deck ('deck') or training document ('doc'). Returns the first assistant message
 * ({ kind, content, data }): the first question not already answered in the conversation.
 */
export async function startInterview({ type, request, previous, docIds }) {
  const sectionCount = docIds?.length ? await countSectionsDb(docIds) : 0;
  // Nothing said yet (a chip pressed on a new chat): nothing to fill in, every question is asked.
  const said = request?.trim() || previous.some((m) => m.kind === 'text' && m.content?.trim());
  const known = said ? await briefFromConversation(previous, type, request, { sectionCount }) : { pinned_chunk_ids: [] };
  // Plans are made from documents (or text the user pasted): say so before asking anything.
  if (!docIds?.length && !known.source_text) {
    throw Object.assign(new Error('Choose the documents to work with first (📎 Documents).'), { statusCode: 400 });
  }
  const options = await coverageOptions(docIds);
  const slots = {};
  if (known.audience) slots.audience = { value: known.audience };
  if (known.named_topics?.length) slots.coverage = { value: known.named_topics.join('; ') };
  if (known.asked_count) slots.length = { value: `${known.asked_count}`, count: known.asked_count };
  if (known.instructions) slots.extras = { value: known.instructions };
  const state = {
    active: true, type, request, slots, tries: 0, options, sectionCount,
    topic: known.topic, tone: known.tone, pinned_chunk_ids: known.pinned_chunk_ids, source_text: known.source_text,
  };
  return nextStep(state);
}

/** The next question, or the summary once every slot has an answer. */
function nextStep(state, { followUp = null, note = '' } = {}) {
  const slot = SLOTS.find((s) => !state.slots[s]);
  if (!slot) return summary({ ...state, asking: null, tries: 0 }, note);
  const q = question(slot, state.type);
  const asking = { ...state, asking: slot, tries: followUp ? state.tries : 0 };
  const options = slot === 'coverage' ? [EVERYTHING, ...state.options] : null;
  return {
    kind: 'interview',
    content: [note, followUp?.text || q.text].filter(Boolean).join(' '),
    data: {
      interview: asking,
      slot,
      suggestions: followUp?.suggestions?.length ? followUp.suggestions : (q.suggestions || []),
      ...(options ? { options, multi: true } : {}),
      step: SLOTS.indexOf(slot) + 1,
      steps: SLOTS.length,
    },
  };
}

// ── Answers ──

/**
 * A user's answer to the question being asked. picked: a suggestion or options they clicked (taken as given);
 * otherwise their typed text is judged and may get a follow-up.
 */
export async function answerInterview(state, text, picked = null) {
  const slot = state.asking;
  if (!slot) return nextStep(state);
  if (picked) return nextStep(fill(state, slot, fromPicked(state, slot, picked)));

  const judged = await judge(state, slot, text);
  if (judged.clear) return nextStep(fill(state, slot, judged.value));
  if (state.tries + 1 > MAX_FOLLOW_UPS) {
    // Two follow-ups are enough: use the best reading, and say so.
    return nextStep(fill(state, slot, { ...judged.value, assumed: true }), {
      note: `I'll go with "${judged.value.value || text}" for now; you can change it on the summary.`,
    });
  }
  return nextStep({ ...state, tries: state.tries + 1 }, { followUp: { text: judged.followUp, suggestions: judged.suggestions } });
}

function fill(state, slot, value) {
  return { ...state, slots: { ...state.slots, [slot]: value }, tries: 0 };
}

/** A clicked suggestion or checklist, as a slot value. */
function fromPicked(state, slot, picked) {
  const list = Array.isArray(picked) ? picked : [picked];
  if (slot === 'coverage') {
    return list.includes(EVERYTHING) || !list.length ? { value: EVERYTHING, all: true } : { value: list.join('; '), parts: list };
  }
  const text = String(list[0] || '');
  if (slot === 'length') {
    const entry = Object.values(LENGTHS[state.type]).find(([label]) => text.startsWith(label));
    return entry ? { value: entry[0], count: entry[1] } : { value: 'Full coverage', full: true };
  }
  if (slot === 'format') {
    const key = Object.keys(FORMATS[state.type]).find((k) => text.startsWith(FORMATS[state.type][k]));
    return { value: FORMATS[state.type][key] || text, format: key };
  }
  if (slot === 'extras' && /^nothing else$/i.test(text)) return { value: '', none: true };
  return { value: text.replace(/\s*\(.*\)$/, '') };
}

const SLOT_RULES = {
  audience: 'Clear when it names any group by role, team, level or experience, even briefly (e.g. "new hires", ' +
    '"maintenance technicians", "managers"). Vague only when it names no group at all: "everyone", "people", ' +
    '"anyone", "users".',
  goal: 'Clear when it names anything concrete they should know, explain, decide or be able to do, even briefly ' +
    '(e.g. "explain how a four-stroke engine works", "know the FY2025 results", "use the torque table"). Vague ' +
    'only when it names nothing concrete: "learn stuff", "learn about it", "understand the document", "training".',
  coverage: 'Clear when it says which parts or topics to cover, or that the whole thing should be covered. Give ' +
    'parts as the exact names from the list of parts below where they match.',
  length: 'Clear when it gives a number of slides/sections, or short / standard / full coverage.',
  format: 'Clear when it matches one of the kinds offered.',
  extras: 'Always clear: anything they mention is fine, and "no" or "nothing" means nothing extra.',
};

/** Judges a typed answer: is it specific enough to plan from, what it means, and if not, a sharper question. */
async function judge(state, slot, text) {
  const q = question(slot, state.type);
  const kind = KINDS[state.type];
  const answered = Object.entries(state.slots).map(([k, v]) => `${k}: ${v.value || '(nothing)'}`).join('; ');
  const formats = FORMATS[state.type];
  const prompt =
    `You help someone plan a ${kind.product} from their documents. You asked: "${q.text}"\n` +
    `They answered: """${text}"""\n` +
    (answered ? `Earlier answers: ${answered}\n` : '') +
    (state.options.length ? `Parts of their documents: ${state.options.join('; ')}\n` : '') +
    `Rule for this question: ${SLOT_RULES[slot]}\n` +
    `Lean towards clear: ask again only when you genuinely could not plan from the answer. Do not ask for more ` +
    `detail on an answer that is already usable.\n\n` +
    `Return: clear (true/false); value (their answer, cleaned up and short, keeping their meaning)` +
    (slot === 'coverage' ? '; parts (the parts it means, exact names from the list, empty for everything); everything (true/false)' : '') +
    (slot === 'length' ? `; count (number of ${kind.nounPlural}, 0 for full coverage)` : '') +
    (slot === 'format' ? `; format (one of: ${Object.keys(formats).join(', ')})` : '') +
    `; follow_up (when not clear: one friendly question of at most 20 words asking for exactly what is missing, with a ` +
    `concrete example drawn from their documents or earlier answers; empty when clear); suggestions (when not ` +
    `clear: 2-3 short example answers they could pick; empty when clear).`;
  const props = {
    clear: { type: 'boolean' }, value: { type: 'string' },
    follow_up: { type: 'string' }, suggestions: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    ...(slot === 'coverage' ? { parts: { type: 'array', items: { type: 'string' } }, everything: { type: 'boolean' } } : {}),
    ...(slot === 'length' ? { count: { type: 'integer' } } : {}),
    ...(slot === 'format' ? { format: { type: 'string', enum: Object.keys(formats) } } : {}),
  };
  let r;
  try {
    r = await generateStructured(prompt, config.ollama.generateModel, { type: 'object', properties: props, required: Object.keys(props) }, { think: false });
  } catch {
    return { clear: true, value: { value: text.trim() } }; // the check failed: take the answer as given
  }
  const value = { value: String(r.value || text).trim() };
  if (slot === 'coverage') {
    let parts = (r.parts || []).filter((p) => state.options.includes(p));
    // Matching (nearly) every part without being asked for everything is no match: keep their own words.
    if (parts.length >= Math.max(2, state.options.length * 0.8)) parts = [];
    if (r.everything || (!parts.length && /\b(all|every|whole|everything)\b/i.test(text))) Object.assign(value, { value: EVERYTHING, all: true });
    else if (parts.length) value.parts = parts;
  }
  if (slot === 'length') {
    const [min, max] = kind.countRange;
    if (r.count >= min && r.count <= max) value.count = r.count;
    else if (r.count === 0) Object.assign(value, { full: true, value: 'Full coverage' });
  }
  if (slot === 'format' && formats[r.format]) Object.assign(value, { format: r.format, value: formats[r.format] });
  if (slot === 'extras' && /^(no|none|nothing( else)?|n\/a)\.?$/i.test(text.trim())) Object.assign(value, { value: '', none: true });
  const clear = slot === 'extras' || Boolean(r.clear);
  return { clear, value, followUp: String(r.follow_up || '').trim() || question(slot, state.type).text, suggestions: r.suggestions || [] };
}

// ── Skipping, changing, summary ──

/** "Just make it": the questions not yet answered are filled with sensible defaults; the summary follows. */
export function skipRest(state) {
  const slots = { ...state.slots };
  if (!slots.audience) slots.audience = { value: '', auto: true };
  if (!slots.goal) slots.goal = { value: '', auto: true };
  if (!slots.coverage) slots.coverage = { value: EVERYTHING, all: true, auto: true };
  if (!slots.length) slots.length = slots.coverage.all ? { value: 'Full coverage', full: true, auto: true } : { value: 'Standard', count: LENGTHS[state.type].standard[1], auto: true };
  if (!slots.format) {
    const key = KINDS[state.type].defaultFormat;
    slots.format = { value: FORMATS[state.type][key], format: key, auto: true };
  }
  if (!slots.extras) slots.extras = { value: '', none: true, auto: true };
  return summary({ ...state, slots, asking: null, tries: 0 });
}

/** Asks one question again (Change on the summary). */
export function reask(state, slot) {
  if (!SLOTS.includes(slot)) return summary(state);
  const { [slot]: _gone, ...slots } = state.slots;
  return nextStep({ ...state, slots, active: true });
}

const LABELS = { audience: 'For', goal: 'Goal', coverage: 'Covers', length: 'Length', format: 'Kind', extras: 'Also' };

function summary(state, note = '') {
  const kind = KINDS[state.type];
  const rows = SLOTS.map((slot) => {
    const v = state.slots[slot] || {};
    let value = v.value;
    if (!value) value = v.auto && slot !== 'extras' ? 'Chosen from the documents' : 'Nothing extra';
    if (slot === 'length' && v.count) value = /^\d+$/.test(v.value) || !v.value ? `${v.count} ${kind.nounPlural}` : `${v.value} (${v.count} ${kind.nounPlural})`;
    return { slot, label: LABELS[slot], value, assumed: Boolean(v.assumed) };
  });
  return {
    kind: 'brief',
    content: [note, `Here's the plan for your ${kind.product}. Change anything, or make the plan.`].filter(Boolean).join(' '),
    data: { interview: { ...state, asking: null }, rows },
  };
}

/** The planner's brief from a finished interview. */
export async function briefFromInterview(state, docIds) {
  const kind = KINDS[state.type];
  const s = state.slots;
  const coverage = s.coverage || {};
  const length = s.length || {};
  const full = coverage.all || length.full;
  const sectionCount = state.sectionCount || (docIds?.length ? await countSectionsDb(docIds) : 0);
  const count = length.count || (full && sectionCount ? fullCoverageCount(kind, sectionCount) : undefined);
  const parts = coverage.all ? '' : coverage.parts?.length ? coverage.parts.join('; ') : coverage.value;
  const topic = [state.request || state.topic || '', parts ? `Cover: ${parts}` : ''].filter(Boolean).join('. ') ||
    (s.goal?.value ? `A ${kind.product} so that the audience can ${s.goal.value}` : `A ${kind.product} from the documents`);
  return {
    topic,
    audience: s.audience?.value || '',
    goal: s.goal?.value || '',
    tone: state.tone || '',
    instructions: s.extras?.value || '',
    ...(count ? { count } : {}),
    scope: coverage.all ? 'full' : 'focused',
    ...(s.format?.format ? { format: s.format.format } : {}),
    pinned_chunk_ids: state.pinned_chunk_ids || [],
    ...(state.source_text ? { source_text: state.source_text } : {}),
  };
}
