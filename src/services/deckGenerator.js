import config from '../config.js';
import { generateStructured, chatStructured, requestEmbedding } from './llm.js';
import { getSimilarChunksDb } from '../db/chunksQueries.js';
import { updateGenerationDb } from '../db/generationsQueries.js';
import { LAYOUT_SCHEMAS, LAYOUT_TYPES } from './slideSchemas.js';

const SLIDE_COUNTS = { quick: [3, 5], standard: [6, 10], deep: [12, 18] };

const outlineSchema = {
  type: 'object',
  properties: {
    slides: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title:  { type: 'string' },
          intent: { type: 'string' },
          layout: {
            type: 'string',
            enum: LAYOUT_TYPES,
          },
        },
        required: ['title', 'intent', 'layout'],
      },
    },
  },
  required: ['slides'],
};

function getSystemPrompt(layout) {
  const base =
    'You are an expert instructional designer creating a professional training slide. ' +
    'Use only the source material provided. ' +
    'Write with authority and precision — avoid filler phrases like "it is important to note" or "as we all know". ' +
    'Use concrete details, specific numbers, and direct language. ' +
    'Every word must earn its place on the slide.';

  const instructions = {
    title:
      `${base}\nWrite a compelling, action-oriented title (max 8 words) and a subtitle that frames the deck's value proposition for the audience. The subtitle should tell them what they will be able to DO after this training.`,
    bullets:
      `${base}\nWrite 3-5 punchy bullet points. Each bullet has a SHORT heading (2-5 words, like a label) and a one-sentence detail that gives the specific insight, fact, or action. Avoid generic advice — every detail should reference concrete information from the source. Write speaker notes that add context, examples, or talking points the presenter needs.`,
    two_column:
      `${base}\nOrganize the content into two distinct columns that create a meaningful comparison, contrast, or categorization. Each column needs a clear heading and 2-4 bullets. The contrast should be immediately obvious — don't just split a list in half. Write speaker notes explaining the significance of the comparison.`,
    stat_focus:
      `${base}\nIdentify the single most striking statistic or metric from the source material — one that would make the audience pause. The stat_value should be a number with its unit (e.g. "73%", "2.4x", "< 30 min"). The stat_label is 2-5 words naming what the stat measures. The context sentence explains why this number matters. Write speaker notes with additional data points and talking points.`,
    quote_highlight:
      `${base}\nExtract a key quote, principle, or doctrinal statement from the source material — something authoritative that anchors the training point. Quote it accurately with proper attribution (name, role, or document title). The commentary should explain why this quote matters for the audience's practice. Write speaker notes that help the presenter discuss the quote.`,
    checklist:
      `${base}\nCreate 4-6 clear, actionable steps forming a procedure or checklist. Each step name should start with a verb (e.g. "Verify", "Submit", "Confirm"). Each detail gives the specific how or what for that step. Steps should follow a logical sequence. Write speaker notes with tips, common mistakes, or additional detail per step.`,
  };

  return instructions[layout] || instructions.bullets;
}

function getUserPrompt(layout, slide, context) {
  const header = `Slide title: ${slide.title}\nSlide intent: ${slide.intent}\n\nSource material:\n${context}\n\n`;

  const directions = {
    title:           `${header}Generate the title (max 8 words, action-oriented) and subtitle (one sentence, audience-focused).`,
    bullets:         `${header}Generate 3-5 bullets. Each heading: 2-5 words, like a label. Each detail: one specific sentence with facts from the source. No filler. Plus speaker notes (3-5 sentences with examples/talking points).`,
    two_column:      `${header}Generate two columns that contrast or categorize meaningfully. Each column: a clear heading and 2-4 concise bullets. Plus speaker notes explaining the comparison.`,
    stat_focus:      `${header}Find the single most impactful number from the source material. stat_value: the number with unit. stat_label: 2-5 words. context: why it matters. Plus speaker notes with supporting data.`,
    quote_highlight: `${header}Extract the most authoritative quote or principle from the source. Quote it accurately. Attribution: who said it or which document. Commentary: one sentence on why it matters. Plus speaker notes.`,
    checklist:       `${header}Generate 4-6 steps in logical order. Each step name starts with a verb. Each detail: the specific how/what. Plus speaker notes with tips or common mistakes.`,
  };

  return directions[layout] || directions.bullets;
}

export async function generateOutline(generation) {
  const { brief, source_document_ids: docIds } = generation;
  const { topic, audience, length, tone } = brief;
  const [min, max] = SLIDE_COUNTS[length] || SLIDE_COUNTS.standard;

  const topicEmbedding = await requestEmbedding(topic);
  const topicChunks = await getSimilarChunksDb(topicEmbedding, 10, docIds);

  const context = topicChunks
    .map((c, i) => `[${i + 1}] (page ${c.page ?? '?'}): ${c.content}`)
    .join('\n\n');

  const prompt =
    `You are an expert instructional designer creating a professional training slide deck.\n\n` +
    `Topic: ${topic}\n` +
    (audience ? `Audience: ${audience}\n` : '') +
    (tone ? `Tone: ${tone}\n` : '') +
    `Slide count: ${min}–${max} slides\n\n` +
    `Available slide layouts:\n` +
    `- "title": Opening slide with a punchy title and value-proposition subtitle. ONLY for the first slide.\n` +
    `- "bullets": Content slide with 3-5 bullet points. Each bullet has a heading and detail. Use for core instructional content.\n` +
    `- "two_column": Side-by-side comparison. Use when two concepts, categories, or approaches need to be contrasted.\n` +
    `- "stat_focus": Highlights one key statistic or metric prominently. Use when a number is the main takeaway.\n` +
    `- "quote_highlight": Features an authoritative quote or key principle. Use for doctrinal statements, regulations, or expert quotes.\n` +
    `- "checklist": Numbered procedure or requirements list. Use for step-by-step processes.\n\n` +
    `Source material:\n${context}\n\n` +
    `Generate an outline. For each slide provide:\n` +
    `- title: A concise, specific slide title (max 8 words). Avoid generic titles like "Introduction" or "Overview" — name the actual topic.\n` +
    `- intent: One sentence describing what the audience should be able to DO after this slide.\n` +
    `- layout: One of the layout types above.\n\n` +
    `Rules:\n` +
    `- The first slide MUST use "title" layout. No other slide should use "title".\n` +
    `- Use at least 3 different layout types. Do NOT make every content slide "bullets" — vary the layouts to keep the audience engaged.\n` +
    `- If the source material contains numbers, stats, or metrics, include at least one "stat_focus" slide.\n` +
    `- If the source material contains procedures or steps, use "checklist" instead of "bullets" for that content.\n` +
    `- Each slide should cover one distinct idea — never cram multiple topics into one slide.\n` +
    `- Use only information from the source material.\n` +
    `- Stay within the slide count range.`;

  const result = await generateStructured(prompt, config.ollama.generateModel, outlineSchema, { think: true });

  const slides = result.slides.map((s, i) => ({
    index: i,
    title: s.title,
    intent: s.intent,
    layout: LAYOUT_TYPES.includes(s.layout) ? s.layout : (i === 0 ? 'title' : 'bullets'),
    source_chunks: topicChunks.slice(0, 3).map((c) => ({
      chunk_id: c.id,
      page: c.page,
      preview: c.content.slice(0, 120),
    })),
  }));

  return { slides };
}

export async function generateSlideContent(generation, slideIndex) {
  const { outline, source_document_ids: docIds } = generation;
  const slide = outline.slides[slideIndex];
  if (!slide) throw new Error(`Slide ${slideIndex} not in outline`);

  const layout = slide.layout || 'bullets';
  const schema = LAYOUT_SCHEMAS[layout];
  if (!schema) throw new Error(`Unknown layout: ${layout}`);

  const slideEmbedding = await requestEmbedding(slide.title + ' ' + slide.intent);
  const chunks = await getSimilarChunksDb(slideEmbedding, 5, docIds);

  const context = chunks
    .map((c, i) => `[${i + 1}] (page ${c.page ?? '?'}): ${c.content}`)
    .join('\n\n');

  const messages = [
    { role: 'system', content: getSystemPrompt(layout) },
    { role: 'user',   content: getUserPrompt(layout, slide, context) },
  ];

  const result = await chatStructured(messages, config.ollama.generateModel, schema, { think: true });

  return {
    ...result,
    source_chunk_ids: chunks.map((c) => c.id),
  };
}

export async function generateAllSlides(generation, onProgress) {
  const { outline } = generation;
  const slides = [];

  for (let i = 0; i < outline.slides.length; i++) {
    if (onProgress) onProgress({ slide: i + 1, total: outline.slides.length, phase: 'slide', title: outline.slides[i].title, layout: outline.slides[i].layout });
    const content = await generateSlideContent(generation, i);
    slides.push({ ...outline.slides[i], content });
  }

  return slides;
}
