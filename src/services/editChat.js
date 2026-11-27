import config from '../config.js';
import { chatStructured } from './llm.js';
import { findSections } from './retrieval.js';
import { stripFigureMarkers } from './figures.js';
import { getGenerationByIdDb, updateGenerationDb } from '../db/generationsQueries.js';
import { SECTION_SCHEMAS } from './docSchemas.js';
import { mermaidGuide, renderWithRepair, DiagramSyntaxError } from './diagrams.js';
import { DOC_LIMITS, fitContent } from './planning/fit.js';
import { KINDS } from './planning/kinds.js';
import { withIcons } from './planning/icons.js';

// Set by the app, not the model: the pictures placed on an item (with captions, position and crop) and a
// diagram's size/crop. Hidden from the model and carried over unchanged, so a chat edit never drops them.
const APP_FIELDS = ['pictures', 'image'];
// Document text an edit can draw on: the sections that best match the instruction.
const EDIT_CONTEXT_CHARS = 12000;
const appFields = (content) => Object.fromEntries(APP_FIELDS.filter((f) => content?.[f] !== undefined).map((f) => [f, content[f]]));
const forModel = (content) => Object.fromEntries(Object.entries(content || {}).filter(([f]) => !APP_FIELDS.includes(f)));

export async function editSlide(generationId, slideIndex, instruction, history = []) {
  const generation = await getGenerationByIdDb(generationId);
  const { outline, source_document_ids: docIds } = generation;

  const slide = outline.slides?.[slideIndex];
  if (!slide?.content) throw new Error(`Slide ${slideIndex} has no generated content`);

  const deck = KINDS.deck;
  const layout = slide.layout;
  const schema = deck.schemas[layout];
  if (!schema) throw new Error('This slide was made by an earlier version of the app; regenerate it first');

  // Sources for the edit, when the generation has documents (pasted-text decks may have none).
  const chunks = (await findSections(instruction, docIds, { k: 3, maxChars: EDIT_CONTEXT_CHARS })).passages;

  const context = chunks
    .map((c, i) => `[${i + 1}] (page ${c.page ?? '?'}): ${stripFigureMarkers(c.content)}`)
    .join('\n\n');

  const currentSlide = JSON.stringify(forModel(slide.content), null, 2);

  const editLog = (generation.edit_history || [])
    .filter((e) => e.slide_index === slideIndex && e.before)
    .map((e) => `User said: "${e.instruction}"\nSlide before that edit:\n${JSON.stringify(e.before, null, 2)}`)
    .join('\n\n---\n\n');

  // Lists: an entry is removed by leaving it out and added by adding one.
  const guide = layout === 'figure'
    ? 'Fields: "title", "caption" (leave it ""), "speaker_notes". The picture and its caption are edited on the slide, not here.'
    : `${deck.writeGuide[layout]}\nTo remove an entry from a list, leave it out; to add one, add an entry.`;

  const messages = [
    {
      role: 'system',
      content:
        `You are editing a single training slide based on a user instruction.\n` +
        `It is a "${layout}" slide. Its fields:\n${guide}\n\n` +
        `IMPORTANT: You must return the COMPLETE updated slide JSON with ALL fields — not a diff or partial update.\n` +
        `Apply exactly what the user asks. If they say "remove" something, actually remove it (omit from arrays, or set to empty).\n` +
        `If they say "change" something, change it and keep everything else the same.\n` +
        `If the instruction references source material, use the provided excerpts.\n` +
        `If the user asks to restore or undo something, use the edit history to find the original content.\n` +
        `You cannot change the kind of slide. If the user asks for a different kind, keep this one; the kind is changed from the slide's toolbar.\n\n` +
        `Current slide content:\n${currentSlide}\n\n` +
        (editLog ? `Edit history for this slide:\n${editLog}\n\n` : '') +
        `Available source material:\n${context}`,
    },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: instruction },
  ];

  let updatedContent = await chatStructured(messages, config.ollama.generateModel, schema, { think: true });
  updatedContent = await fitContent(deck.limits[layout], schema, updatedContent);
  updatedContent = await withIcons(layout, updatedContent, slide.content);
  if (layout === 'figure') delete updatedContent.caption; // the picture's caption lives with the picture
  if (layout === 'diagram') updatedContent = await renderEditedDiagram(generation, updatedContent, schema);

  const updatedSlides = [...outline.slides];
  updatedSlides[slideIndex] = {
    ...slide,
    content: { ...updatedContent, ...appFields(slide.content), source_chunk_ids: slide.content.source_chunk_ids },
  };

  const editEntry = {
    slide_index: slideIndex,
    instruction,
    before: slide.content,
    timestamp: new Date().toISOString(),
  };

  const editHistory = [...(generation.edit_history || []), editEntry];

  await updateGenerationDb(generationId, {
    outline: JSON.stringify({ ...outline, slides: updatedSlides }),
    edit_history: editHistory,
  });

  return updatedContent;
}

const sectionGuide = {
  heading: 'Fields: "title", "subtitle", "summary".',
  body: 'Fields: "title", "paragraphs" (array of {subheading, text}), "key_takeaway". To remove a paragraph, omit it. To add one, add a new {subheading, text} entry.',
  procedure: 'Fields: "title", "introduction", "steps" (array of {step_number, action, detail, caution}), "notes". To remove a step, omit it. To add one, add a new entry. caution can be empty string if no safety concern.',
  key_points: 'Fields: "title", "introduction", "points" (array of {label, description}), "notes". To remove a point, omit it from the array.',
  reference_table: 'Fields: "title", "introduction", "columns" (array of header strings), "rows" (array of arrays matching column count), "notes". To add a row, add an array. To add a column, add to columns and extend each row.',
  summary: 'Fields: "title", "recap_points" (array of strings), "next_steps", "notes". To remove a point, omit it from the array.',
  figure: 'Fields: "title", "introduction", "caption" (leave it ""), "notes". The picture and its caption are edited on the page, not here.',
  diagram: `Fields: "title", "introduction", "diagram_type" (flowchart, sequence or mindmap), "mermaid_code", "caption" (short figure title), "notes". To change the figure, edit mermaid_code.\n${mermaidGuide({ direction: 'TD' })}`,
};

export async function editSection(generationId, sectionIndex, instruction, history = []) {
  const generation = await getGenerationByIdDb(generationId);
  const { outline, source_document_ids: docIds } = generation;

  const section = outline.sections?.[sectionIndex];
  if (!section?.content) throw new Error(`Section ${sectionIndex} has no generated content`);

  const sType = section.section_type || 'body';
  const schema = SECTION_SCHEMAS[sType];
  if (!schema) throw new Error(`Unknown section type: ${sType}`);

  // Sources for the edit, when the generation has documents (pasted-text decks may have none).
  const chunks = (await findSections(instruction, docIds, { k: 3, maxChars: EDIT_CONTEXT_CHARS })).passages;

  const context = chunks
    .map((c, i) => `[${i + 1}] (page ${c.page ?? '?'}): ${stripFigureMarkers(c.content)}`)
    .join('\n\n');

  const currentSection = JSON.stringify(forModel(section.content), null, 2);

  const editLog = (generation.edit_history || [])
    .filter((e) => e.section_index === sectionIndex && e.before)
    .map((e) => `User said: "${e.instruction}"\nSection before that edit:\n${JSON.stringify(e.before, null, 2)}`)
    .join('\n\n---\n\n');

  const messages = [
    {
      role: 'system',
      content:
        `You are editing a single section of a training document based on a user instruction.\n` +
        `The section uses the "${sType}" type.\n` +
        `${sectionGuide[sType] || ''}\n\n` +
        `IMPORTANT: You must return the COMPLETE updated section JSON with ALL fields — not a diff or partial update.\n` +
        `Apply exactly what the user asks. If they say "remove" something, actually remove it.\n` +
        `If they say "change" something, change it and keep everything else the same.\n` +
        `If the instruction references source material, use the provided excerpts.\n` +
        `You cannot change the section type.\n\n` +
        `Current section content:\n${currentSection}\n\n` +
        (editLog ? `Edit history for this section:\n${editLog}\n\n` : '') +
        `Available source material:\n${context}`,
    },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: instruction },
  ];

  let updatedContent = await chatStructured(messages, config.ollama.generateModel, schema, { think: true });
  updatedContent = await fitContent(DOC_LIMITS[sType], schema, updatedContent);
  if (sType === 'figure') delete updatedContent.caption; // the picture's caption lives with the picture
  if (sType === 'diagram') updatedContent = await renderEditedDiagram(generation, updatedContent, schema);

  const updatedSections = [...outline.sections];
  updatedSections[sectionIndex] = {
    ...section,
    content: { ...updatedContent, ...appFields(section.content), source_chunk_ids: section.content.source_chunk_ids },
  };

  const editEntry = {
    section_index: sectionIndex,
    instruction,
    before: section.content,
    timestamp: new Date().toISOString(),
  };

  const editHistory = [...(generation.edit_history || []), editEntry];

  await updateGenerationDb(generationId, {
    outline: JSON.stringify({ ...outline, sections: updatedSections }),
    edit_history: editHistory,
  });

  return updatedContent;
}

// Edited diagrams are re-rendered before saving. If the code still doesn't parse after one repair, the edit is
// rejected and the previous version stays, so a slide or section never points at a missing image.
async function renderEditedDiagram(generation, content, schema) {
  try {
    return await renderWithRepair(generation, content, schema);
  } catch (err) {
    if (err instanceof DiagramSyntaxError) {
      throw new Error(`That change produced a diagram that doesn't render, so nothing was changed. Mermaid said: ${err.message.split('\n')[0]}`);
    }
    throw err;
  }
}
