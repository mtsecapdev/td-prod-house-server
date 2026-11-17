import config from '../config.js';
import { generateStructured, chatStructured, requestEmbedding } from './llm.js';
import { getSimilarChunksDb } from '../db/chunksQueries.js';
import { SECTION_SCHEMAS, SECTION_TYPES } from './docSchemas.js';
import { mermaidGuide, renderWithRepair, DiagramSyntaxError } from './diagrams.js';

const SECTION_COUNTS = { short: [4, 8], standard: [8, 14], comprehensive: [14, 22] };

const outlineSchema = {
  type: 'object',
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title:        { type: 'string' },
          intent:       { type: 'string' },
          section_type: {
            type: 'string',
            enum: SECTION_TYPES,
          },
        },
        required: ['title', 'intent', 'section_type'],
      },
    },
  },
  required: ['sections'],
};

function getSystemPrompt(sectionType) {
  const base =
    'You are an expert technical writer creating a professional training document section. ' +
    'Use only the source material provided. ' +
    'Write in clear, direct prose — avoid filler phrases like "it is important to note" or "as we all know". ' +
    'Use concrete details, specific numbers, and precise language. ' +
    'Every sentence must convey useful information.';

  const instructions = {
    heading:
      `${base}\nWrite a document title (max 10 words), a subtitle that frames the document's purpose for the reader, and a brief executive summary (2-3 sentences) of what the document covers and why it matters.`,
    body:
      `${base}\nWrite 2-4 paragraphs of instructional content. Each paragraph has a subheading (3-6 words, like a section label) and substantive body text (3-6 sentences with specific facts, data, or instructions from the source). End with a key_takeaway: one sentence capturing the single most important point from this section.`,
    procedure:
      `${base}\nWrite a step-by-step procedure. Start with a brief introduction (1-2 sentences explaining when and why to follow this procedure). Then write 4-8 clear steps. Each step has: a step_number, an action (verb-first, e.g. "Verify", "Connect", "Submit"), a detail (specific how/what in 1-2 sentences), and a caution (leave empty string if no safety concern; otherwise a specific warning). End with notes for additional context.`,
    key_points:
      `${base}\nExtract 4-8 key facts, rules, or principles from the source material. Start with a brief introduction (1-2 sentences framing why these points matter). Each point has a label (2-5 words, like a category name) and a description (1-3 sentences explaining the rule or fact with specifics). End with notes for additional context.`,
    reference_table:
      `${base}\nOrganize the source content into a reference table. Start with a brief introduction (1-2 sentences explaining what this table contains and how to use it). Define column headers (3-6 columns), then provide rows of data. Each row is an array of strings matching the columns. End with notes explaining any abbreviations or special values.`,
    diagram:
      `${base}\nIllustrate this section with a Mermaid diagram that a reader can follow on the page, such as a process with decision points, a hand-off between roles, or how parts of a system relate. Write an introduction (1-2 sentences saying what the figure shows and when to use it), the diagram, a caption (one short sentence, used as the figure title), and notes explaining any steps or branches that need more detail. Top-down flowcharts suit a portrait page.\n\n${mermaidGuide({ direction: 'TD' })}`,
    summary:
      `${base}\nWrite a closing summary section. Provide 4-6 recap_points — each a concise sentence restating one key learning from the document. Then write next_steps: a short paragraph (2-3 sentences) on what the reader should do after reading this document. End with notes for any final remarks.`,
  };

  return instructions[sectionType] || instructions.body;
}

function getUserPrompt(sectionType, section, context) {
  const header = `Section title: ${section.title}\nSection intent: ${section.intent}\n\nSource material:\n${context}\n\n`;

  const directions = {
    heading:         `${header}Generate the document title (max 10 words), subtitle (one sentence), and executive summary (2-3 sentences).`,
    body:            `${header}Generate 2-4 paragraphs. Each subheading: 3-6 words. Each text: 3-6 sentences with facts from the source. Plus a key_takeaway (one sentence).`,
    procedure:       `${header}Generate a procedure. Introduction: 1-2 sentences. Steps: 4-8, each with step_number, verb-first action, detail, and caution (empty string if none). Plus notes.`,
    key_points:      `${header}Generate 4-8 key points. Introduction: 1-2 sentences. Each point: a label (2-5 words) and description (1-3 sentences with specifics). Plus notes.`,
    reference_table: `${header}Generate a reference table. Introduction: 1-2 sentences. Columns: 3-6 header strings. Rows: arrays of strings matching column count. Plus notes.`,
    diagram:         `${header}Generate an introduction (1-2 sentences), a Mermaid diagram (valid syntax, top-down, 4-10 nodes), a caption (one short sentence) and notes.`,
    summary:         `${header}Generate a summary. recap_points: 4-6 concise sentences. next_steps: 2-3 sentences on what to do next. Plus notes.`,
  };

  return directions[sectionType] || directions.body;
}

export async function generateDocOutline(generation) {
  const { brief, source_document_ids: docIds } = generation;
  const { topic, audience, length, tone } = brief;
  const [min, max] = SECTION_COUNTS[length] || SECTION_COUNTS.standard;

  const topicEmbedding = await requestEmbedding(topic);
  const topicChunks = await getSimilarChunksDb(topicEmbedding, 10, docIds);

  const context = topicChunks
    .map((c, i) => `[${i + 1}] (page ${c.page ?? '?'}): ${c.content}`)
    .join('\n\n');

  const prompt =
    `You are an expert technical writer creating a professional training document outline.\n\n` +
    `Topic: ${topic}\n` +
    (audience ? `Audience: ${audience}\n` : '') +
    (tone ? `Tone: ${tone}\n` : '') +
    `Section count: ${min}–${max} sections\n\n` +
    `Available section types:\n` +
    `- "heading": Document title page with title, subtitle, and executive summary. ONLY for the first section.\n` +
    `- "body": Core instructional content with subheadings and paragraphs. Use for explanatory/descriptive material.\n` +
    `- "procedure": Step-by-step instructions with numbered actions. Use for SOPs, how-to sequences, maintenance steps.\n` +
    `- "key_points": Highlighted facts, rules, or principles. Use for safety rules, regulations, critical requirements.\n` +
    `- "reference_table": Tabular data with columns and rows. Use for specs, comparisons, lookup tables, parameters.\n` +
    `- "diagram": A figure (flowchart, sequence diagram or mind map) with a short introduction. Use for processes with decision points, hand-offs between roles or systems, or structures that are clearer as a picture. Max 1-3 per document.\n` +
    `- "summary": Closing recap with key takeaways and next steps. ONLY for the last section.\n\n` +
    `Source material:\n${context}\n\n` +
    `Generate an outline. For each section provide:\n` +
    `- title: A clear, specific section title (max 10 words). Name the actual topic, not generic labels.\n` +
    `- intent: One sentence describing what the reader will know or be able to do after this section.\n` +
    `- section_type: One of the types above.\n\n` +
    `Rules:\n` +
    `- The first section MUST use "heading". No other section should use "heading".\n` +
    `- The last section MUST use "summary".\n` +
    `- Use at least 3 different section types between the first and last.\n` +
    `- If the source material contains procedures or steps, use "procedure" for that content.\n` +
    `- If the source contains data, specifications, or comparisons, use "reference_table".\n` +
    `- If the source contains safety rules, regulations, or critical facts, use "key_points".\n` +
    `- Each section should cover one distinct topic — don't cram multiple subjects into one section.\n` +
    `- Use only information from the source material.\n` +
    `- Stay within the section count range.`;

  const result = await generateStructured(prompt, config.ollama.generateModel, outlineSchema, { think: true });

  const sections = result.sections.map((s, i) => ({
    index: i,
    title: s.title,
    intent: s.intent,
    section_type: SECTION_TYPES.includes(s.section_type) ? s.section_type : (i === 0 ? 'heading' : 'body'),
    source_chunks: topicChunks.slice(0, 3).map((c) => ({
      chunk_id: c.id,
      page: c.page,
      preview: c.content.slice(0, 120),
    })),
  }));

  return { sections };
}

// A diagram that still fails to render after one repair becomes a procedure, so one bad diagram never
// stops the document.
const DIAGRAM_FALLBACK_TYPE = 'procedure';

/**
 * Generates one section. Returns { section_type, content }; the type differs from the outline only when a
 * diagram had to fall back.
 */
export async function generateSectionContent(generation, sectionIndex) {
  const section = generation.outline.sections[sectionIndex];
  if (!section) throw new Error(`Section ${sectionIndex} not in outline`);
  const sectionType = section.section_type || 'body';

  const content = await generateTypeContent(generation, section, sectionType);
  if (sectionType !== 'diagram') return { section_type: sectionType, content };

  try {
    return { section_type: sectionType, content: await renderWithRepair(generation.id, content, SECTION_SCHEMAS.diagram) };
  } catch (err) {
    if (!(err instanceof DiagramSyntaxError)) throw err;
    console.warn(`Section ${sectionIndex + 1}: diagram failed to render (${err.message.split('\n')[0]}); using ${DIAGRAM_FALLBACK_TYPE}`);
    return {
      section_type: DIAGRAM_FALLBACK_TYPE,
      content: await generateTypeContent(generation, section, DIAGRAM_FALLBACK_TYPE),
    };
  }
}

async function generateTypeContent(generation, section, sectionType) {
  const { source_document_ids: docIds } = generation;
  const schema = SECTION_SCHEMAS[sectionType];
  if (!schema) throw new Error(`Unknown section type: ${sectionType}`);

  const sectionEmbedding = await requestEmbedding(section.title + ' ' + section.intent);
  const chunks = await getSimilarChunksDb(sectionEmbedding, 5, docIds);

  const context = chunks
    .map((c, i) => `[${i + 1}] (page ${c.page ?? '?'}): ${c.content}`)
    .join('\n\n');

  const messages = [
    { role: 'system', content: getSystemPrompt(sectionType) },
    { role: 'user',   content: getUserPrompt(sectionType, section, context) },
  ];

  const result = await chatStructured(messages, config.ollama.generateModel, schema, { think: true });

  return {
    ...result,
    source_chunk_ids: chunks.map((c) => c.id),
  };
}

/**
 * Generates every section in order. onSectionDone(sections) runs after each one so the caller can save
 * progress. With resume, sections that already have content (from an interrupted run) are kept.
 */
export async function generateAllSections(generation, { onProgress, onSectionDone, resume = false } = {}) {
  const sections = generation.outline.sections.map((s) => ({ ...s }));

  for (let i = 0; i < sections.length; i++) {
    if (resume && sections[i].content) continue;
    if (onProgress) onProgress({
      section: i + 1,
      total: sections.length,
      phase: 'section',
      title: sections[i].title,
      section_type: sections[i].section_type,
    });
    const { section_type, content } = await generateSectionContent(generation, i);
    sections[i] = { ...sections[i], section_type, content };
    if (onSectionDone) await onSectionDone(sections);
  }

  return sections;
}
