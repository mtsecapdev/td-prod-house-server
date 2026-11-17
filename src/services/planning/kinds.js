// What differs between a slide deck and a training document. The planner and writer are shared and read
// everything kind-specific from here.
import { LAYOUT_SCHEMAS, LAYOUT_TYPES } from '../slideSchemas.js';
import { SECTION_SCHEMAS, SECTION_TYPES } from '../docSchemas.js';
import { mermaidGuide } from '../diagrams.js';

const DECK = {
  name: 'deck',
  noun: 'slide',
  nounPlural: 'slides',
  product: 'training slide deck',
  listKey: 'slides',
  typeKey: 'layout',
  types: LAYOUT_TYPES,
  schemas: LAYOUT_SCHEMAS,
  defaultType: 'bullets',
  firstType: 'title',
  lastType: 'closing',
  diagramFallback: 'process_flow',
  sourcesPerItem: 4,
  idPrefix: 's_',
  counts: { quick: [3, 5], standard: [6, 10], deep: [12, 18] },
  messageCounts: { quick: [2, 3], standard: [3, 5], deep: [4, 6] },
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
    section_divider: 'Opens a new part of a longer deck (8+ slides).',
    big_idea: 'One statement the audience must remember. At most one or two per deck.',
    timeline: 'Dated events or phases in order.',
    process_flow: 'A linear process where each step feeds the next.',
    icon_grid: 'Three to six parallel concepts or categories of equal weight.',
    comparison_table: 'Several items compared on the same attributes.',
    diagram: 'A process with decisions or branches, a hand-off between roles or systems, or a structure such as an org or system.',
    closing: 'Final slide: takeaways and what to do next. Last slide only.',
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
  defaultType: 'body',
  firstType: 'heading',
  lastType: 'summary',
  diagramFallback: 'procedure',
  sourcesPerItem: 7,
  idPrefix: 'x_',
  counts: { short: [4, 8], standard: [8, 14], comprehensive: [14, 22] },
  messageCounts: { short: [2, 4], standard: [3, 6], comprehensive: [5, 8] },
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

const AUDIENCE_LEVELS = {
  new: 'The audience is new to this topic: define terms and acronyms the first time, and avoid assumed knowledge.',
  familiar: 'The audience knows the basics: skip introductions to common terms and focus on specifics.',
  expert: 'The audience is expert: be precise and dense; no basics.',
};

const TONES = {
  formal: 'Tone: formal and authoritative.',
  instructional: 'Tone: clear and instructional.',
  conversational: 'Tone: approachable and conversational, still precise.',
  professional: 'Tone: professional.',
};

/** The deck- or document-wide writing rules built from the brief. Identical for every item. */
export function styleGuide(kind, brief = {}) {
  const format = kind.formats[brief.format] ? brief.format : kind.defaultFormat;
  return [
    `Format: ${kind.formats[format]}`,
    kind.titleStyle[format],
    AUDIENCE_LEVELS[brief.audience_level] || '',
    TONES[brief.tone] || '',
    'Grounding: every number, name, date and quote you write must appear in the sources given for this item. ' +
      'If the sources do not support a point, leave it out rather than inventing a figure.',
    'Write in plain English. No filler ("it is important to note"), no hype, no emoji.',
  ].filter(Boolean).join('\n');
}

/** The brief, as the model should read it. */
export function briefBlock(generation) {
  const b = generation.brief || {};
  const kind = kindOf(generation);
  const lines = [
    `Topic: ${b.topic}`,
    b.purpose ? `Purpose (what the audience should be able to do afterwards): ${b.purpose}` : '',
    b.audience ? `Audience: ${b.audience}` : '',
    b.format && kind.formats[b.format] ? `Format: ${b.format}` : '',
    b.include ? `Must include: ${b.include}` : '',
    b.exclude ? `Leave out: ${b.exclude}` : '',
    b.notes ? `Other notes from the user: ${b.notes}` : '',
  ];
  const answered = (b.questions || []).filter((q) => q.answer && q.answer.trim());
  if (answered.length) {
    lines.push('Answers to clarifying questions:');
    for (const q of answered) lines.push(`- Q: ${q.question}\n  A: ${q.answer}`);
  }
  return lines.filter(Boolean).join('\n');
}

export function storylineBlock(storyline) {
  if (!storyline?.messages?.length) return '';
  const lines = [`Thesis: ${storyline.thesis}`];
  if (storyline.arc) lines.push(`Arc: ${storyline.arc}`);
  lines.push('Key messages, in order:');
  storyline.messages.forEach((m, i) => lines.push(`${i + 1}. [${m.id}] ${m.text}`));
  if (storyline.out_of_scope?.length) {
    lines.push('Deliberately out of scope:');
    for (const o of storyline.out_of_scope) lines.push(`- ${o.section}${o.reason ? ` (${o.reason})` : ''}`);
  }
  return lines.join('\n');
}
