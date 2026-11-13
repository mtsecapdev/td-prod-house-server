import config from '../config.js';
import { chatStructured, requestEmbedding } from './llm.js';
import { getSimilarChunksDb } from '../db/chunksQueries.js';
import { getGenerationByIdDb, updateGenerationDb } from '../db/generationsQueries.js';
import { LAYOUT_SCHEMAS } from './slideSchemas.js';
import { SECTION_SCHEMAS } from './docSchemas.js';
import { INFOGRAPHIC_SCHEMAS } from './infographicSchemas.js';
import { renderInfographic } from './infographicGenerator.js';

export async function editSlide(generationId, slideIndex, instruction, history = []) {
  const generation = await getGenerationByIdDb(generationId);
  const { outline, source_document_ids: docIds } = generation;

  const slide = outline.slides?.[slideIndex];
  if (!slide?.content) throw new Error(`Slide ${slideIndex} has no generated content`);

  const layout = slide.layout || 'bullets';
  const schema = LAYOUT_SCHEMAS[layout];
  if (!schema) throw new Error(`Unknown layout: ${layout}`);

  const instructionEmbedding = await requestEmbedding(instruction);
  const chunks = await getSimilarChunksDb(instructionEmbedding, 3, docIds);

  const context = chunks
    .map((c, i) => `[${i + 1}] (page ${c.page ?? '?'}): ${c.content}`)
    .join('\n\n');

  const currentSlide = JSON.stringify(slide.content, null, 2);

  const editLog = (generation.edit_history || [])
    .filter((e) => e.slide_index === slideIndex && e.before)
    .map((e) => `User said: "${e.instruction}"\nSlide before that edit:\n${JSON.stringify(e.before, null, 2)}`)
    .join('\n\n---\n\n');

  const layoutGuide = {
    title: 'Fields: "title" (slide title), "subtitle" (subtitle text).',
    bullets: 'Fields: "title" (slide title), "bullets" (array of {heading, detail}), "speaker_notes". To remove a bullet, omit it from the array. To add one, add a new {heading, detail} entry.',
    two_column: 'Fields: "title" (slide title), "column_a_heading", "column_a_bullets" (array of strings), "column_b_heading", "column_b_bullets" (array of strings), "speaker_notes". To remove a column, set its heading to "" and its bullets to []. To remove specific bullets, omit them from the array.',
    stat_focus: 'Fields: "title" (slide title), "stat_value" (the number/metric), "stat_label" (what it measures), "context" (why it matters), "speaker_notes".',
    quote_highlight: 'Fields: "title" (slide title), "quote_text" (the quote), "attribution" (who said it), "commentary" (why it matters), "speaker_notes".',
    checklist: 'Fields: "title" (slide title), "items" (array of {step, detail}), "speaker_notes". To remove a step, omit it from the array. To add one, add a new {step, detail} entry.',
    closing: 'Fields: "title" (slide title), "takeaways" (array of strings), "call_to_action" (optional string), "speaker_notes".',
    section_divider: 'Fields: "title" (section name, 2-5 words), "subtitle" (one sentence priming the audience).',
    big_idea: 'Fields: "statement" (one bold sentence, max 15 words), "supporting" (one sentence of context/evidence), "speaker_notes".',
    timeline: 'Fields: "title" (slide title), "events" (array of {date, label, detail}), "speaker_notes". To remove an event, omit it. To add one, insert in chronological position.',
    process_flow: 'Fields: "title" (slide title), "steps" (array of {label, detail}), "speaker_notes". To remove a step, omit it. To add one, add a new {label, detail} entry in sequence.',
    icon_grid: 'Fields: "title" (slide title), "items" (array of {icon, label, description}), "speaker_notes". icon is a single keyword. To remove an item, omit it. To add one, add a new entry.',
    comparison_table: 'Fields: "title" (slide title), "columns" (array of header strings), "rows" (array of arrays matching column count), "speaker_notes". To add a row, add an array. To add a column, add to columns and extend each row.',
  };

  const messages = [
    {
      role: 'system',
      content:
        `You are editing a single training slide based on a user instruction.\n` +
        `The slide uses the "${layout}" layout.\n` +
        `${layoutGuide[layout] || ''}\n\n` +
        `IMPORTANT: You must return the COMPLETE updated slide JSON with ALL fields — not a diff or partial update.\n` +
        `Apply exactly what the user asks. If they say "remove" something, actually remove it (omit from arrays, or set to empty).\n` +
        `If they say "change" something, change it and keep everything else the same.\n` +
        `If the instruction references source material, use the provided excerpts.\n` +
        `If the user asks to restore or undo something, use the edit history to find the original content.\n` +
        `You cannot change the slide layout type. If the user asks for a layout change, keep the current layout and note in speaker_notes that the layout should be changed on the Outline page.\n\n` +
        `Current slide content:\n${currentSlide}\n\n` +
        (editLog ? `Edit history for this slide:\n${editLog}\n\n` : '') +
        `Available source material:\n${context}`,
    },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: instruction },
  ];

  const updatedContent = await chatStructured(messages, config.ollama.generateModel, schema, { think: true });

  const updatedSlides = [...outline.slides];
  updatedSlides[slideIndex] = {
    ...slide,
    content: { ...updatedContent, source_chunk_ids: slide.content.source_chunk_ids },
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
};

export async function editSection(generationId, sectionIndex, instruction, history = []) {
  const generation = await getGenerationByIdDb(generationId);
  const { outline, source_document_ids: docIds } = generation;

  const section = outline.sections?.[sectionIndex];
  if (!section?.content) throw new Error(`Section ${sectionIndex} has no generated content`);

  const sType = section.section_type || 'body';
  const schema = SECTION_SCHEMAS[sType];
  if (!schema) throw new Error(`Unknown section type: ${sType}`);

  const instructionEmbedding = await requestEmbedding(instruction);
  const chunks = await getSimilarChunksDb(instructionEmbedding, 3, docIds);

  const context = chunks
    .map((c, i) => `[${i + 1}] (page ${c.page ?? '?'}): ${c.content}`)
    .join('\n\n');

  const currentSection = JSON.stringify(section.content, null, 2);

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

  const updatedContent = await chatStructured(messages, config.ollama.generateModel, schema, { think: true });

  const updatedSections = [...outline.sections];
  updatedSections[sectionIndex] = {
    ...section,
    content: { ...updatedContent, source_chunk_ids: section.content.source_chunk_ids },
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

const infographicGuide = {
  diagram:
    'Fields: "diagram_type" (flowchart, sequence, or mindmap), "title", "mermaid_code" (valid Mermaid.js syntax). ' +
    'When editing mermaid_code, ensure the output is syntactically valid Mermaid. ' +
    'Do NOT change diagram_type unless the user specifically asks.',
  process:
    'Fields: "title", "subtitle", "steps" (array of {number, label, description}). ' +
    'To remove a step, omit it. To add one, add a new entry with the correct number. Renumber if needed.',
  comparison:
    'Fields: "title", "subtitle", "column_a" ({heading, points[]}), "column_b" ({heading, points[]}), "verdict". ' +
    'To remove a point, omit it from the array. To add one, append a string.',
  key_stats:
    'Fields: "title", "subtitle", "stats" (array of {value, label, detail}). ' +
    'To remove a stat, omit it. To add one, add a new {value, label, detail} entry.',
  timeline:
    'Fields: "title", "subtitle", "events" (array of {date, label, description}). ' +
    'To remove an event, omit it. To add one, add a new entry in chronological position.',
};

export async function editInfographic(generationId, instruction, history = []) {
  const generation = await getGenerationByIdDb(generationId);
  const { outline, source_document_ids: docIds } = generation;

  const format = outline?.format;
  const content = outline?.content;
  if (!content) throw new Error('No infographic content to edit');

  const schema = INFOGRAPHIC_SCHEMAS[format];
  if (!schema) throw new Error(`Unknown infographic format: ${format}`);

  const instructionEmbedding = await requestEmbedding(instruction);
  const chunks = await getSimilarChunksDb(instructionEmbedding, 3, docIds);

  const context = chunks
    .map((c, i) => `[${i + 1}] (page ${c.page ?? '?'}): ${c.content}`)
    .join('\n\n');

  const currentContent = JSON.stringify(content, null, 2);

  const editLog = (generation.edit_history || [])
    .filter((e) => e.type === 'infographic' && e.before)
    .map((e) => `User said: "${e.instruction}"\nContent before that edit:\n${JSON.stringify(e.before, null, 2)}`)
    .join('\n\n---\n\n');

  const messages = [
    {
      role: 'system',
      content:
        `You are editing a ${format} infographic based on a user instruction.\n` +
        `${infographicGuide[format] || ''}\n\n` +
        `IMPORTANT: You must return the COMPLETE updated JSON with ALL fields — not a diff or partial update.\n` +
        `Apply exactly what the user asks. If they say "remove" something, actually remove it.\n` +
        `If they say "change" something, change it and keep everything else the same.\n` +
        `If the instruction references source material, use the provided excerpts.\n\n` +
        `Current content:\n${currentContent}\n\n` +
        (editLog ? `Edit history:\n${editLog}\n\n` : '') +
        `Available source material:\n${context}`,
    },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: instruction },
  ];

  const updatedContent = await chatStructured(messages, config.ollama.generateModel, schema, { think: true });

  const filePath = await renderInfographic(generationId, format, updatedContent);

  const editEntry = {
    type: 'infographic',
    instruction,
    before: content,
    timestamp: new Date().toISOString(),
  };

  const editHistory = [...(generation.edit_history || []), editEntry];

  await updateGenerationDb(generationId, {
    outline: JSON.stringify({ format, content: updatedContent, file_path: filePath }),
    edit_history: editHistory,
  });

  return updatedContent;
}
