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
      type: 'array', maxItems: 5,
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
      type: 'array', maxItems: 12,
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
      type: 'array', maxItems: 8,
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
    columns:      { type: 'array', maxItems: 6, items: { type: 'string' } },
    rows: {
      type: 'array', maxItems: 15,
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
    recap_points:  { type: 'array', maxItems: 6, items: { type: 'string' } },
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

// A section built around a figure from the source documents; the picture and its caption live in
// content.pictures (set by the app), like pictures added to any other section.
export const figureSectionSchema = {
  type: 'object',
  properties: {
    title:        { type: 'string' },
    introduction: { type: 'string' },
    caption:      { type: 'string' }, // used only when the document gives the figure no caption
    notes:        { type: 'string' },
  },
  required: ['title', 'introduction', 'caption', 'notes'],
};

export const SECTION_SCHEMAS = {
  heading:         headingSectionSchema,
  body:            bodySectionSchema,
  procedure:       procedureSectionSchema,
  key_points:      keyPointsSectionSchema,
  reference_table: referenceTableSectionSchema,
  diagram:         diagramSectionSchema,
  figure:          figureSectionSchema,
  summary:         summarySectionSchema,
};

export const SECTION_TYPES = Object.keys(SECTION_SCHEMAS);
