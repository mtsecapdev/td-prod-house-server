// What differs between a slide deck and a training document. The planner and writer are shared and read
// everything kind-specific from here. Decks come from the slide design spec (shared/slides/spec.js), which the
// layout engine and the editor read too.
import { KINDS as SLIDE_KINDS, KIND_NAMES, DEFAULT_KIND, FIRST_KIND, LAST_KIND, writerSchema, fieldLimits, writeGuide } from '../../../shared/slides/spec.js';
import { SECTION_SCHEMAS, SECTION_TYPES } from '../docSchemas.js';
import { mermaidGuide, DIAGRAM_TYPES } from '../diagrams.js';
import { DOC_LIMITS } from './fit.js';

const slideKinds = (test) => KIND_NAMES.filter((k) => test(SLIDE_KINDS[k]));
const byKind = (fn) => Object.fromEntries(KIND_NAMES.map((k) => [k, fn(k)]));

const DECK = {
  name: 'deck',
  noun: 'slide',
  nounPlural: 'slides',
  product: 'training slide deck',
  listKey: 'slides',
  typeKey: 'layout',
  types: KIND_NAMES,
  schemas: byKind((k) => writerSchema(k, { diagramTypes: DIAGRAM_TYPES })),
  limits: byKind((k) => fieldLimits(k)),
  defaultType: DEFAULT_KIND,
  firstType: FIRST_KIND,
  lastType: LAST_KIND,
  diagramFallback: 'steps',
  sourcesPerItem: 4,
  idPrefix: 's_',
  countRange: [3, 25],
  defaultCount: 8,
  // Facts the planner quotes per slide: a slide shows a few.
  planPoints: { range: '2-5', max: 6 },
  // Items that frame the deck rather than carry evidence: no sources searched for them.
  noSourceTypes: slideKinds((k) => !k.sourced),
  // Kinds that need something the planner or the user attaches (a figure), never offered as a change of kind.
  appOnlyTypes: slideKinds((k) => k.figure),
  // A long-deck kind: only in decks of this many slides or more.
  minCount: byKind((k) => SLIDE_KINDS[k].minDeck || 0),
  // Kinds a figure from the documents can sit beside (in a panel the layout engine makes room for).
  pictureTypes: slideKinds((k) => k.picture),

  // Shown to the planner: what each kind is for.
  typeGuide: byKind((k) => SLIDE_KINDS[k].use),

  // How to fill each kind (fields, then lengths).
  writeGuide: byKind((k) => {
    if (k === 'diagram') {
      return `caption: one sentence telling the audience what the diagram shows. The slide is wide (16:9): prefer ` +
        `left-to-right flowcharts with at most 8 nodes.\n${mermaidGuide({ direction: 'LR' })}`;
    }
    if (k === 'figure') {
      return 'The slide shows a figure from the documents (its caption and the text printed in it are given; the ' +
        'caption from the document is shown under it). title: what the audience should see in it. caption: only ' +
        'for a figure the document gave no caption: a few plain words saying what the picture shows (e.g. "Cover ' +
        'of the handbook"); never a figure number or a name the sources do not give it. speaker_notes: walk ' +
        'through the figure using its text.';
    }
    return writeGuide(k);
  }),

  formats: {
    presented: 'Presented live by a speaker. Slide text is short phrases the speaker talks over, not full paragraphs. speaker_notes are a script: what to say, the transition to the next slide, and where useful a question for the audience (4-8 sentences).',
    read: 'Read alone without a presenter. Each slide must make sense on its own, in full sentences. speaker_notes are 1-3 sentences of extra context.',
    both: 'Presented, then shared to read later. Slide text is concise but self-explanatory. speaker_notes are a short script (3-5 sentences).',
  },
  defaultFormat: 'presented',
  titleStyle: {
    presented: 'Titles state the slide\'s point as a short assertion of at most 10 words.',
    read: 'Titles name the topic and the finding in at most 12 words.',
    both: 'Titles state the slide\'s point as a short assertion of at most 10 words.',
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
  appOnlyTypes: ['figure'],
  // Facts the planner quotes per section: sections are prose, built from more of them.
  planPoints: { range: '4-8', max: 8 },
  minCount: {},
  // A figure planned for a section is shown in it.
  pictureTypes: ['body', 'procedure', 'key_points', 'reference_table', 'summary'],

  typeGuide: {
    heading: 'Title page: document title, purpose and a short executive summary. First section only.',
    body: 'Explanation in paragraphs with subheadings.',
    procedure: 'Numbered steps the reader carries out, with cautions where something can go wrong.',
    key_points: 'Rules, requirements or facts the reader must remember.',
    reference_table: 'Data to look up: specifications, comparisons, parameters, contacts.',
    diagram: 'A figure: a process with decisions, a hand-off between roles or systems, or a structure.',
    figure: 'A figure taken from the source documents (assigned by the app).',
    summary: 'Recap and next steps. Last section only.',
  },

  writeGuide: {
    heading: 'title: max 10 words. subtitle: one sentence on the document\'s purpose for the reader. summary: 2-4 sentences on what it covers and why it matters.',
    body: '2-5 paragraphs. subheading: 3-6 words, a different one for each paragraph (or empty to continue the one before). text: 2-4 sentences, each a fact from the sources; when the sources run out, stop rather than add interpretation (what something "reflects", "drives" or "positions"). key_takeaway: one sentence: the section\'s main fact as the sources state it.',
    procedure: 'introduction: when and why to follow it (1-2 sentences). 3-10 steps: step_number, action (verb first), detail (1-2 sentences), caution (a specific warning, or an empty string). notes: anything else the reader needs.',
    key_points: 'introduction: 1-2 sentences. 3-8 points: label (2-5 words), description (1-3 sentences with specifics). notes: optional context.',
    reference_table: 'introduction: what the table holds and how to use it. 2-6 columns; rows of short cells matching the columns. notes: abbreviations or special values.',
    diagram: `introduction: what the figure shows and when to use it (1-2 sentences). caption: a short figure title. notes: explanation of steps or branches that need it. Top-down flowcharts suit a portrait page.\n${mermaidGuide({ direction: 'TD' })}`,
    figure: 'The section shows a figure from the documents (its caption and the text printed in it are given; the caption from the document is shown under it). introduction: what the figure shows and why it matters (1-2 sentences). caption: only for a figure the document gave no caption: a few plain words saying what the picture shows (e.g. "Cover of the handbook"); never a figure number or a name the sources do not give it. notes: explain the figure using its text.',
    summary: 'recap_points: one per key message of the document, each one sentence. next_steps: 2-3 sentences on what the reader should do next. notes: optional.',
  },

  formats: {
    learning: 'A learning guide read through once, start to finish. Build understanding step by step and explain why, not only what.',
    reference: 'A reference looked up when needed. Each section stands on its own; lead with the answer; favour tables and lists over narrative.',
    procedure: 'A procedure manual followed at work. Be exact about order, quantities and responsibilities; put cautions next to the step they apply to.',
  },
  defaultFormat: 'learning',
  titleStyle: {
    learning: 'Section titles name the topic plainly in at most 10 words.',
    reference: 'Section titles name exactly what can be looked up there, in at most 10 words.',
    procedure: 'Section titles name the task in at most 10 words, verb first where it is a procedure.',
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
    brief.goal ? `Goal: afterwards the audience should ${brief.goal.replace(/^to\s+/i, '')}. Everything should serve it.` : '',
    brief.tone ? `Tone: ${brief.tone}.` : '',
    // "Stress safety" once produced safety claims the manual never makes: instructions steer, facts stay facts.
    brief.instructions ? `Instructions from the user: ${brief.instructions}. Follow them in what you emphasise, how ` +
      'you word it and how you arrange it, using the facts given; they never add facts the sources do not state.' : '',
    'Grounding: every number, name, date and quote you write must come from the facts given for this item ' +
      'or the user\'s own text. The planned points are a guide to what to cover, not a source of facts. If the ' +
      'facts do not support a point, leave it out rather than inventing it.',
    'Write in plain English. No filler ("it is important to note"), no hype, no emoji. State facts directly: never ' +
      'refer to the sources, documents or documentation in the text ("as stated in the sources").',
  ].filter(Boolean).join('\n');
}

/** The brief, as the planning model should read it. */
export function briefBlock(generation) {
  const b = generation.brief || {};
  const kind = kindOf(generation);
  return [
    `What the user asked for: ${b.topic}`,
    b.audience ? `Audience: ${b.audience}` : '',
    b.goal ? `Goal (what the audience should know or be able to do afterwards): ${b.goal}` : '',
    b.format && kind.formats[b.format] ? `Format: ${b.format}` : '',
    b.instructions ? `Extra instructions: ${b.instructions}` : '',
    b.source_text ? `The user supplied their own text to build from (mode: ${b.text_mode || 'generate'}).` : '',
  ].filter(Boolean).join('\n');
}

/** The plan's thesis: the one sentence the audience should leave with. */
export function storylineBlock(storyline) {
  return storyline?.thesis ? `Thesis: ${storyline.thesis}` : '';
}
