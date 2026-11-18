// What differs between a slide deck and a training document. The planner and writer are shared and read
// everything kind-specific from here.
import { LAYOUT_SCHEMAS, LAYOUT_TYPES } from '../slideSchemas.js';
import { SECTION_SCHEMAS, SECTION_TYPES } from '../docSchemas.js';
import { mermaidGuide } from '../diagrams.js';
import { DECK_LIMITS, DOC_LIMITS } from './fit.js';

const DECK = {
  name: 'deck',
  noun: 'slide',
  nounPlural: 'slides',
  product: 'training slide deck',
  listKey: 'slides',
  typeKey: 'layout',
  types: LAYOUT_TYPES,
  schemas: LAYOUT_SCHEMAS,
  limits: DECK_LIMITS,
  defaultType: 'bullets',
  firstType: 'title',
  lastType: 'closing',
  diagramFallback: 'process_flow',
  sourcesPerItem: 4,
  idPrefix: 's_',
  countRange: [3, 25],
  defaultCount: 8,
  // Items that frame the deck rather than carry evidence: no sources searched for them.
  noSourceTypes: ['title', 'closing', 'section_divider'],

  // Shown to the outline model. Describes what each layout is FOR, so it can match content to layout;
  // none is framed as an exception to bullets.
  typeGuide: {
    title: 'Opening slide: deck title and what the audience will get. First slide only.',
    bullets: 'A few parallel points that explain or teach.',
    two_column: 'Two things compared or contrasted: before/after, option A/B, do/don\'t.',
    stat_focus: 'One number that matters more than any other on this topic.',
    key_stats: 'Several related figures shown together: results, KPIs, scale.',
    quote_highlight: 'A verbatim quote, rule or principle that appears in the sources.',
    checklist: 'An ordered procedure the audience will carry out.',
    section_divider: 'Opens a new part of a long deck (10+ slides only).',
    big_idea: 'One statement the audience must remember. At most one or two per deck.',
    timeline: 'Dated events or phases in order.',
    process_flow: 'A linear process where each step feeds the next.',
    icon_grid: 'Three to six parallel concepts or categories of equal weight.',
    comparison_table: 'Several items compared on the same attributes.',
    diagram: 'A process with decisions or branches, a hand-off between roles or systems, or a structure such as an org or system.',
    closing: 'Final slide: takeaways and what to do next. Last slide only.',
  },

  // What a slide's content can be, and the layout each maps to (see layouts.js). The model classifies content;
  // code picks the layout and checks the evidence.
  shapes: {
    points: { layout: 'bullets', what: 'a set of points, reasons or facts (the usual case, even when they contain figures)' },
    headline_numbers: { layout: 'key_stats', what: 'mostly figures: 3+ points that each state a headline number (results, KPIs, shares)' },
    single_number: { layout: 'stat_focus', what: 'one headline figure that the whole slide is about' },
    actions: { layout: 'checklist', what: 'actions the audience should take, each starting with a verb' },
    sequence: { layout: 'process_flow', what: 'stages of a process, each leading to the next' },
    dated_events: { layout: 'timeline', what: 'events or milestones tied to dates' },
    comparison: { layout: 'comparison_table', what: 'the same measures given for several items or years (segments, sites, years)' },
    contrast: { layout: 'two_column', what: 'two sides set against each other: before/after, option A/B' },
    process_with_decisions: { layout: 'diagram', what: 'a process with decisions, branches or hand-offs between people or systems' },
    quotation: { layout: 'quote_highlight', what: 'a statement quoted from a named person or a document' },
    statement: { layout: 'big_idea', what: 'one message to remember, little else' },
    parallel_concepts: { layout: 'icon_grid', what: '3-6 parallel categories or pillars of equal weight' },
  },

  // How to fill each layout. Ranges, not fixed counts: the content decides.
  writeGuide: {
    title: 'title: max 8 words naming the subject. subtitle: one sentence on what the audience will be able to do afterwards.',
    bullets: '2-6 bullets. heading: 2-5 words. detail: one sentence with the specific fact, reason or action.',
    two_column: 'Two columns that genuinely contrast, each with a heading and 2-5 bullets. verdict: one sentence stating the conclusion if the comparison leads to one, otherwise an empty string.',
    stat_focus: 'stat_value: the one number that best supports the point, with its unit. stat_label: 2-5 words. context: one sentence on why it matters.',
    key_stats: '2-6 figures that together support the point. value: number with unit. label: 2-4 words. detail: one sentence on what drove it or why it matters.',
    quote_highlight: 'quote_text: copied exactly from the sources, never paraphrased or invented. attribution: the person, role or document. commentary: one sentence on why it matters here.',
    checklist: '3-8 steps in order. step: starts with a verb. detail: how to do it.',
    closing: 'title: signals the wrap-up. takeaways: 3-5, one per key message of the deck, each one sentence. call_to_action: one sentence, or an empty string.',
    section_divider: 'title: 2-5 words naming the part. subtitle: one sentence on what it covers.',
    big_idea: 'statement: max 15 words, quotable. supporting: one sentence of evidence.',
    timeline: '3-7 events in date order. date, label (2-5 words), detail (one sentence).',
    process_flow: '3-7 steps where each feeds the next. label: verb first, 2-4 words. detail: one sentence.',
    icon_grid: '3-6 items. icon: one keyword (shield, clock, users). label: 2-4 words. description: one sentence.',
    comparison_table: '2-5 columns and 2-7 rows. Cells are short phrases. The table should reveal a pattern.',
    diagram: `caption: one sentence telling the audience what the diagram shows. The slide is wide (16:9): prefer left-to-right flowcharts with at most 8 nodes.\n${mermaidGuide({ direction: 'LR' })}`,
  },

  formats: {
    presented: 'Presented live by a speaker. Slide text is short phrases the speaker talks over, not full paragraphs. speaker_notes are a script: what to say, the transition to the next slide, and where useful a question for the audience (4-8 sentences).',
    read: 'Read alone without a presenter. Each slide must make sense on its own, in full sentences. speaker_notes are 1-3 sentences of extra context.',
    both: 'Presented, then shared to read later. Slide text is concise but self-explanatory. speaker_notes are a short script (3-5 sentences).',
  },
  defaultFormat: 'presented',
  titleStyle: {
    presented: 'Titles state the slide\'s point as a short assertion (max 10 words).',
    read: 'Titles name the topic and the finding (max 12 words).',
    both: 'Titles state the slide\'s point as a short assertion (max 10 words).',
  },
};

const DOC = {
  name: 'doc',
  noun: 'section',
  nounPlural: 'sections',
  product: 'training document',
  listKey: 'sections',
  typeKey: 'section_type',
  types: SECTION_TYPES,
  schemas: SECTION_SCHEMAS,
  limits: DOC_LIMITS,
  defaultType: 'body',
  firstType: 'heading',
  lastType: 'summary',
  diagramFallback: 'procedure',
  sourcesPerItem: 7,
  idPrefix: 'x_',
  countRange: [3, 20],
  defaultCount: 8,
  noSourceTypes: ['heading', 'summary'],

  typeGuide: {
    heading: 'Title page: document title, purpose and a short executive summary. First section only.',
    body: 'Explanation in paragraphs with subheadings.',
    procedure: 'Numbered steps the reader carries out, with cautions where something can go wrong.',
    key_points: 'Rules, requirements or facts the reader must remember.',
    reference_table: 'Data to look up: specifications, comparisons, parameters, contacts.',
    diagram: 'A figure: a process with decisions, a hand-off between roles or systems, or a structure.',
    summary: 'Recap and next steps. Last section only.',
  },

  shapes: {
    points: { layout: 'body', what: 'explanation: ideas, reasons or context (the usual case)' },
    actions: { layout: 'procedure', what: 'steps the reader carries out, in order' },
    rules: { layout: 'key_points', what: 'rules, requirements or facts the reader must remember' },
    data: { layout: 'reference_table', what: 'data to look up, or items compared on the same attributes' },
    process_with_decisions: { layout: 'diagram', what: 'a process with decisions, branches or hand-offs between people or systems' },
  },

  writeGuide: {
    heading: 'title: max 10 words. subtitle: one sentence on the document\'s purpose for the reader. summary: 2-4 sentences on what it covers and why it matters.',
    body: '2-5 paragraphs. subheading: 3-6 words. text: 3-6 sentences with specifics from the sources. key_takeaway: one sentence.',
    procedure: 'introduction: when and why to follow it (1-2 sentences). 3-10 steps: step_number, action (verb first), detail (1-2 sentences), caution (a specific warning, or an empty string). notes: anything else the reader needs.',
    key_points: 'introduction: 1-2 sentences. 3-8 points: label (2-5 words), description (1-3 sentences with specifics). notes: optional context.',
    reference_table: 'introduction: what the table holds and how to use it. 2-6 columns; rows of short cells matching the columns. notes: abbreviations or special values.',
    diagram: `introduction: what the figure shows and when to use it (1-2 sentences). caption: a short figure title. notes: explanation of steps or branches that need it. Top-down flowcharts suit a portrait page.\n${mermaidGuide({ direction: 'TD' })}`,
    summary: 'recap_points: one per key message of the document, each one sentence. next_steps: 2-3 sentences on what the reader should do next. notes: optional.',
  },

  formats: {
    learning: 'A learning guide read through once, start to finish. Build understanding step by step and explain why, not only what.',
    reference: 'A reference looked up when needed. Each section stands on its own; lead with the answer; favour tables and lists over narrative.',
    procedure: 'A procedure manual followed at work. Be exact about order, quantities and responsibilities; put cautions next to the step they apply to.',
  },
  defaultFormat: 'learning',
  titleStyle: {
    learning: 'Section titles name the topic plainly (max 10 words).',
    reference: 'Section titles name exactly what can be looked up there (max 10 words).',
    procedure: 'Section titles name the task (verb first where it is a procedure, max 10 words).',
  },
};

export const KINDS = { deck: DECK, doc: DOC };

export function kindOf(generation) {
  const kind = KINDS[generation.type];
  if (!kind) throw new Error(`Generation type ${generation.type} has no planning flow`);
  return kind;
}

// Gamma-style text amount: how much each item carries. Applied when writing, so it can change without
// rebuilding the outline.
const TEXT_AMOUNTS = {
  minimal: 'Text amount: minimal. Headline-driven: the fewest items the layout allows, each a short phrase. Put detail in speaker notes.',
  concise: 'Text amount: concise. Short items, one idea each, one sentence of detail at most.',
  detailed: 'Text amount: detailed. Use the upper end of each range, with full sentences and supporting specifics.',
};

/** Number of items to plan, clamped to what the kind allows. */
export function itemCount(kind, brief = {}) {
  const [min, max] = kind.countRange;
  const n = Number(brief.count) || kind.defaultCount;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** The deck- or document-wide writing rules built from the brief. Identical for every item. */
export function styleGuide(kind, brief = {}) {
  const format = kind.formats[brief.format] ? brief.format : kind.defaultFormat;
  return [
    `Format: ${kind.formats[format]}`,
    kind.titleStyle[format],
    TEXT_AMOUNTS[brief.text_amount] || TEXT_AMOUNTS.concise,
    brief.audience ? `Audience: ${brief.audience}. Pitch terms and depth to them.` : '',
    brief.tone ? `Tone: ${brief.tone}.` : '',
    brief.instructions ? `Instructions from the user (follow them): ${brief.instructions}` : '',
    'Grounding: every number, name, date and quote you write must appear in the sources given for this item ' +
      'or in the user\'s own text. ' +
      'The planned bullets are a guide to what to cover, not a source of facts. If the sources do not support a ' +
      'point, leave it out rather than inventing a figure.',
    'Write in plain English. No filler ("it is important to note"), no hype, no emoji.',
  ].filter(Boolean).join('\n');
}

/** The brief, as the planning model should read it. */
export function briefBlock(generation) {
  const b = generation.brief || {};
  const kind = kindOf(generation);
  return [
    `What the user asked for: ${b.topic}`,
    b.audience ? `Audience: ${b.audience}` : '',
    b.format && kind.formats[b.format] ? `Format: ${b.format}` : '',
    b.instructions ? `Extra instructions: ${b.instructions}` : '',
    b.source_text ? `The user supplied their own text to build from (mode: ${b.text_mode || 'generate'}).` : '',
  ].filter(Boolean).join('\n');
}

/** The plan's thesis: the one sentence the audience should leave with. */
export function storylineBlock(storyline) {
  return storyline?.thesis ? `Thesis: ${storyline.thesis}` : '';
}
