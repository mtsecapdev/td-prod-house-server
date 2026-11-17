import { DIAGRAM_TYPES } from './diagrams.js';

export const headingSectionSchema = {
  type: 'object',
  properties: {
    title:    { type: 'string' },
    subtitle: { type: 'string' },
    summary:  { type: 'string' },
  },
  required: ['title', 'subtitle', 'summary'],
};

export const bodySectionSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    paragraphs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subheading: { type: 'string' },
          text:       { type: 'string' },
        },
        required: ['subheading', 'text'],
      },
    },
    key_takeaway: { type: 'string' },
  },
  required: ['title', 'paragraphs', 'key_takeaway'],
};

export const procedureSectionSchema = {
  type: 'object',
  properties: {
    title:        { type: 'string' },
    introduction: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          step_number: { type: 'integer' },
          action:      { type: 'string' },
          detail:      { type: 'string' },
          caution:     { type: 'string' },
        },
        required: ['step_number', 'action', 'detail', 'caution'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['title', 'introduction', 'steps', 'notes'],
};

export const keyPointsSectionSchema = {
  type: 'object',
  properties: {
    title:        { type: 'string' },
    introduction: { type: 'string' },
    points: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label:       { type: 'string' },
          description: { type: 'string' },
        },
        required: ['label', 'description'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['title', 'introduction', 'points', 'notes'],
};

export const referenceTableSectionSchema = {
  type: 'object',
  properties: {
    title:        { type: 'string' },
    introduction: { type: 'string' },
    columns:      { type: 'array', items: { type: 'string' } },
    rows: {
      type: 'array',
      items: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    notes: { type: 'string' },
  },
  required: ['title', 'introduction', 'columns', 'rows', 'notes'],
};

export const summarySectionSchema = {
  type: 'object',
  properties: {
    title:         { type: 'string' },
    recap_points:  { type: 'array', items: { type: 'string' } },
    next_steps:    { type: 'string' },
    notes:         { type: 'string' },
  },
  required: ['title', 'recap_points', 'next_steps', 'notes'],
};

// diagram_file (the rendered PNG's key) is added by the server after rendering; the model never writes it.
export const diagramSectionSchema = {
  type: 'object',
  properties: {
    title:        { type: 'string' },
    introduction: { type: 'string' },
    diagram_type: { type: 'string', enum: DIAGRAM_TYPES },
    mermaid_code: { type: 'string' },
    caption:      { type: 'string' },
    notes:        { type: 'string' },
  },
  required: ['title', 'introduction', 'diagram_type', 'mermaid_code', 'caption', 'notes'],
};

export const SECTION_SCHEMAS = {
  heading:         headingSectionSchema,
  body:            bodySectionSchema,
  procedure:       procedureSectionSchema,
  key_points:      keyPointsSectionSchema,
  reference_table: referenceTableSectionSchema,
  diagram:         diagramSectionSchema,
  summary:         summarySectionSchema,
};

export const SECTION_TYPES = Object.keys(SECTION_SCHEMAS);
