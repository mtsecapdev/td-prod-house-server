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
      type: 'array',
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
      type: 'array',
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
      type: 'array',
      items: {
        type: 'object',
        properties: {
          icon:        { type: 'string' },
          label:       { type: 'string' },
          description: { type: 'string' },
        },
        required: ['label', 'description'],
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
    columns: { type: 'array', items: { type: 'string' } },
    rows: {
      type: 'array',
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
      type: 'array',
      items: { type: 'string' },
    },
    call_to_action: { type: 'string' },
    speaker_notes:  { type: 'string' },
  },
  required: ['title', 'takeaways', 'speaker_notes'],
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
  closing:          closingSlideSchema,
};

export const LAYOUT_TYPES = Object.keys(LAYOUT_SCHEMAS);
