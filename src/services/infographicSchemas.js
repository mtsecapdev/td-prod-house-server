export const diagramSchema = {
  type: 'object',
  properties: {
    diagram_type: { type: 'string', enum: ['flowchart', 'sequence', 'mindmap'] },
    title:        { type: 'string' },
    mermaid_code: { type: 'string' },
  },
  required: ['diagram_type', 'title', 'mermaid_code'],
};

export const processSchema = {
  type: 'object',
  properties: {
    title:    { type: 'string' },
    subtitle: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          number:      { type: 'integer' },
          label:       { type: 'string' },
          description: { type: 'string' },
        },
        required: ['number', 'label', 'description'],
      },
    },
  },
  required: ['title', 'subtitle', 'steps'],
};

export const comparisonSchema = {
  type: 'object',
  properties: {
    title:    { type: 'string' },
    subtitle: { type: 'string' },
    column_a: {
      type: 'object',
      properties: {
        heading: { type: 'string' },
        points:  { type: 'array', items: { type: 'string' } },
      },
      required: ['heading', 'points'],
    },
    column_b: {
      type: 'object',
      properties: {
        heading: { type: 'string' },
        points:  { type: 'array', items: { type: 'string' } },
      },
      required: ['heading', 'points'],
    },
    verdict: { type: 'string' },
  },
  required: ['title', 'subtitle', 'column_a', 'column_b', 'verdict'],
};

export const keyStatsSchema = {
  type: 'object',
  properties: {
    title:    { type: 'string' },
    subtitle: { type: 'string' },
    stats: {
      type: 'array',
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
  },
  required: ['title', 'subtitle', 'stats'],
};

export const timelineSchema = {
  type: 'object',
  properties: {
    title:    { type: 'string' },
    subtitle: { type: 'string' },
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date:        { type: 'string' },
          label:       { type: 'string' },
          description: { type: 'string' },
        },
        required: ['date', 'label', 'description'],
      },
    },
  },
  required: ['title', 'subtitle', 'events'],
};

export const INFOGRAPHIC_SCHEMAS = {
  diagram:    diagramSchema,
  process:    processSchema,
  comparison: comparisonSchema,
  key_stats:  keyStatsSchema,
  timeline:   timelineSchema,
};

export const INFOGRAPHIC_TYPES = Object.keys(INFOGRAPHIC_SCHEMAS);
