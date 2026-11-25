import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIAGRAM_TYPES } from './diagrams.js';

// The icons a point can carry: the images the renderer has (scripts/icons, built by scripts/build_icons.mjs).
export const ICON_NAMES = readdirSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'icons'))
  .filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)).sort();
const iconField = { type: 'string', enum: ICON_NAMES };

export const titleSlideSchema = {
  type: 'object',
  properties: {
    title:    { type: 'string' },
    subtitle: { type: 'string' },
  },
  required: ['title', 'subtitle'],
};

export const bulletsSlideSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    bullets: {
      type: 'array', maxItems: 6,
      items: {
        type: 'object',
        properties: {
          icon:    iconField,
          heading: { type: 'string' },
          detail:  { type: 'string' },
        },
        required: ['icon', 'heading', 'detail'],
      },
    },
    speaker_notes: { type: 'string' },
  },
  required: ['title', 'bullets', 'speaker_notes'],
};

export const twoColumnSlideSchema = {
  type: 'object',
  properties: {
    title:             { type: 'string' },
    column_a_heading:  { type: 'string' },
    column_a_bullets:  { type: 'array', maxItems: 5, items: { type: 'string' } },
    column_b_heading:  { type: 'string' },
    column_b_bullets:  { type: 'array', maxItems: 5, items: { type: 'string' } },
    verdict:           { type: 'string' }, // optional one-line takeaway under the columns
    speaker_notes:     { type: 'string' },
  },
  required: ['title', 'column_a_heading', 'column_a_bullets', 'column_b_heading', 'column_b_bullets', 'speaker_notes'],
};

export const statFocusSlideSchema = {
  type: 'object',
  properties: {
    title:         { type: 'string' },
    stat_value:    { type: 'string' },
    stat_label:    { type: 'string' },
    context:       { type: 'string' },
    speaker_notes: { type: 'string' },
  },
  required: ['title', 'stat_value', 'stat_label', 'context', 'speaker_notes'],
};

export const quoteHighlightSlideSchema = {
  type: 'object',
  properties: {
    title:         { type: 'string' },
    quote_text:    { type: 'string' },
    attribution:   { type: 'string' },
    commentary:    { type: 'string' },
    speaker_notes: { type: 'string' },
  },
  required: ['title', 'quote_text', 'attribution', 'commentary', 'speaker_notes'],
};

export const checklistSlideSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    items: {
      type: 'array', maxItems: 8,
      items: {
        type: 'object',
        properties: {
          step:   { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['step', 'detail'],
      },
    },
    speaker_notes: { type: 'string' },
  },
  required: ['title', 'items', 'speaker_notes'],
};

export const sectionDividerSlideSchema = {
  type: 'object',
  properties: {
    title:    { type: 'string' },
    subtitle: { type: 'string' },
  },
  required: ['title', 'subtitle'],
};

export const bigIdeaSlideSchema = {
  type: 'object',
  properties: {
    statement:     { type: 'string' },
    supporting:    { type: 'string' },
    speaker_notes: { type: 'string' },
  },
  required: ['statement', 'supporting', 'speaker_notes'],
};

export const timelineSlideSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    events: {
      type: 'array', maxItems: 7,
      items: {
        type: 'object',
        properties: {
          date:   { type: 'string' },
          label:  { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['date', 'label'],
      },
    },
    speaker_notes: { type: 'string' },
  },
  required: ['title', 'events', 'speaker_notes'],
};

export const processFlowSlideSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    steps: {
      type: 'array', maxItems: 7,
      items: {
        type: 'object',
        properties: {
          label:  { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['label', 'detail'],
      },
    },
    speaker_notes: { type: 'string' },
  },
  required: ['title', 'steps', 'speaker_notes'],
};

export const iconGridSlideSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    items: {
      type: 'array', maxItems: 6,
      items: {
        type: 'object',
        properties: {
          icon:        iconField,
          label:       { type: 'string' },
          description: { type: 'string' },
        },
        required: ['icon', 'label', 'description'],
      },
    },
    speaker_notes: { type: 'string' },
  },
  required: ['title', 'items', 'speaker_notes'],
};

export const comparisonTableSlideSchema = {
  type: 'object',
  properties: {
    title:   { type: 'string' },
    columns: { type: 'array', maxItems: 5, items: { type: 'string' } },
    rows: {
      type: 'array', maxItems: 7,
      items: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    speaker_notes: { type: 'string' },
  },
  required: ['title', 'columns', 'rows', 'speaker_notes'],
};

export const closingSlideSchema = {
  type: 'object',
  properties: {
    title:      { type: 'string' },
    takeaways:  {
      type: 'array', maxItems: 5,
      items: { type: 'string' },
    },
    call_to_action: { type: 'string' },
    speaker_notes:  { type: 'string' },
  },
  required: ['title', 'takeaways', 'speaker_notes'],
};

export const keyStatsSlideSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    stats: {
      type: 'array', maxItems: 6,
      items: {
        type: 'object',
        properties: {
          value:  { type: 'string' },
          label:  { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['value', 'label', 'detail'],
      },
    },
    speaker_notes: { type: 'string' },
  },
  required: ['title', 'stats', 'speaker_notes'],
};

// diagram_file (the rendered PNG's key) is added by the server after rendering; the model never writes it.
export const diagramSlideSchema = {
  type: 'object',
  properties: {
    title:         { type: 'string' },
    diagram_type:  { type: 'string', enum: DIAGRAM_TYPES },
    mermaid_code:  { type: 'string' },
    caption:       { type: 'string' },
    speaker_notes: { type: 'string' },
  },
  required: ['title', 'diagram_type', 'mermaid_code', 'caption', 'speaker_notes'],
};

// A slide built around a figure from the source documents. The picture and its caption live in
// content.pictures (set by the app, never by the model), like pictures added to any other slide.
export const figureSlideSchema = {
  type: 'object',
  properties: {
    title:         { type: 'string' },
    caption:       { type: 'string' }, // used only when the document gives the figure no caption
    speaker_notes: { type: 'string' },
  },
  required: ['title', 'caption', 'speaker_notes'],
};

export const LAYOUT_SCHEMAS = {
  title:            titleSlideSchema,
  bullets:          bulletsSlideSchema,
  two_column:       twoColumnSlideSchema,
  stat_focus:       statFocusSlideSchema,
  quote_highlight:  quoteHighlightSlideSchema,
  checklist:        checklistSlideSchema,
  section_divider:  sectionDividerSlideSchema,
  big_idea:         bigIdeaSlideSchema,
  timeline:         timelineSlideSchema,
  process_flow:     processFlowSlideSchema,
  icon_grid:        iconGridSlideSchema,
  comparison_table: comparisonTableSlideSchema,
  key_stats:        keyStatsSlideSchema,
  diagram:          diagramSlideSchema,
  figure:           figureSlideSchema,
  closing:          closingSlideSchema,
};

export const LAYOUT_TYPES = Object.keys(LAYOUT_SCHEMAS);
