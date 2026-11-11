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
      type: 'array',
      items: {
        type: 'object',
        properties: {
          heading: { type: 'string' },
          detail:  { type: 'string' },
        },
        required: ['heading', 'detail'],
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
    column_a_bullets:  { type: 'array', items: { type: 'string' } },
    column_b_heading:  { type: 'string' },
    column_b_bullets:  { type: 'array', items: { type: 'string' } },
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
      type: 'array',
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

export const LAYOUT_SCHEMAS = {
  title:           titleSlideSchema,
  bullets:         bulletsSlideSchema,
  two_column:      twoColumnSlideSchema,
  stat_focus:      statFocusSlideSchema,
  quote_highlight: quoteHighlightSlideSchema,
  checklist:       checklistSlideSchema,
};

export const LAYOUT_TYPES = Object.keys(LAYOUT_SCHEMAS);
