import { execFile } from 'node:child_process';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import config from '../config.js';
import { generateStructured, requestEmbedding } from './llm.js';
import { getSimilarChunksDb } from '../db/chunksQueries.js';
import { INFOGRAPHIC_SCHEMAS } from './infographicSchemas.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

function getSystemPrompt(format) {
  const base =
    'You are an expert training content designer. ' +
    'Use only the source material provided. ' +
    'Write with precision — every word must earn its place.';

  const prompts = {
    diagram:
      `${base}\n` +
      `Generate a Mermaid.js diagram. The mermaid_code field must be VALID Mermaid syntax.\n\n` +
      `Supported diagram types and their syntax:\n` +
      `- flowchart: Start with "flowchart TD" (top-down) or "flowchart LR" (left-right). ` +
      `Use A[Label] --> B[Label] for connections. Use {Label} for decisions.\n` +
      `- sequence: Start with "sequenceDiagram". Use participant, ->>, -->> arrows.\n` +
      `- mindmap: Start with "mindmap". Indent child nodes with spaces.\n\n` +
      `Rules:\n` +
      `- Keep labels short (max 5 words per node)\n` +
      `- Use 5-12 nodes for flowcharts, 3-8 participants for sequences, 4-10 leaves for mindmaps\n` +
      `- Do NOT use special characters in labels — no quotes, parentheses inside node text, or HTML\n` +
      `- The title should describe what the diagram shows\n` +
      `- Choose diagram_type based on the content: flowchart for processes, sequence for interactions, mindmap for hierarchies`,

    process:
      `${base}\n` +
      `Generate a process flow infographic with 4-8 numbered steps.\n` +
      `Each step needs a short label (2-4 words) and a one-sentence description.\n` +
      `Steps must follow a logical sequence from the source material.\n` +
      `The title and subtitle should clearly frame what process is being shown.`,

    comparison:
      `${base}\n` +
      `Generate a comparison infographic with two columns.\n` +
      `Each column needs a clear heading and 3-5 concise bullet points.\n` +
      `The comparison should be meaningful — don't just split a list in half.\n` +
      `The verdict summarizes the key takeaway from the comparison.\n` +
      `The title and subtitle should frame what's being compared.`,

    key_stats:
      `${base}\n` +
      `Generate a key statistics infographic highlighting 3-6 important numbers.\n` +
      `Each stat needs: a value (number + unit like "73%" or "2.4x"), a short label (2-4 words), ` +
      `and a one-sentence detail explaining why it matters.\n` +
      `Find the most striking, concrete numbers from the source material.\n` +
      `The title and subtitle should frame what domain these stats cover.`,

    timeline:
      `${base}\n` +
      `Generate a timeline infographic with 4-8 events in chronological order.\n` +
      `Each event needs: a date or time period, a short label (2-4 words), ` +
      `and a one-sentence description.\n` +
      `The title and subtitle should frame what timeline is being shown.`,
  };

  return prompts[format] || prompts.process;
}

function getUserPrompt(format, brief, context) {
  return (
    `Topic: ${brief.topic}\n` +
    (brief.audience ? `Audience: ${brief.audience}\n` : '') +
    `\nSource material:\n${context}\n\n` +
    `Generate the ${format} content based on the source material above.`
  );
}

export async function generateInfographic(generation, onProgress) {
  const { brief, source_document_ids: docIds } = generation;
  const format = brief.format || 'process';
  const schema = INFOGRAPHIC_SCHEMAS[format];
  if (!schema) throw new Error(`Unknown infographic format: ${format}`);

  onProgress({ phase: 'generating', message: 'Generating content...' });

  const topicEmbedding = await requestEmbedding(brief.topic);
  const chunks = await getSimilarChunksDb(topicEmbedding, 10, docIds);

  const context = chunks
    .map((c, i) => `[${i + 1}] (page ${c.page ?? '?'}): ${c.content}`)
    .join('\n\n');

  const systemPrompt = getSystemPrompt(format);
  const userPrompt = getUserPrompt(format, brief, context);

  const content = await generateStructured(
    `${systemPrompt}\n\n${userPrompt}`,
    config.ollama.generateModel,
    schema,
    { think: true },
  );

  onProgress({ phase: 'rendering', message: 'Rendering to PNG...' });

  const filePath = await renderInfographic(generation.id, format, content);

  return { format, content, file_path: filePath };
}

export async function renderInfographic(generationId, format, content) {
  const outDir = join(config.outputDir, 'infographics');
  await mkdir(outDir, { recursive: true });

  const inputPath = join(outDir, `${generationId}_input.json`);
  const outputPath = join(outDir, `${generationId}.png`);
  const scriptPath = join(__dirname, '..', '..', 'scripts', 'render_infographic.py');

  await writeFile(inputPath, JSON.stringify({ format, content }), 'utf-8');

  try {
    await execFileAsync('python', [scriptPath, inputPath, outputPath], { timeout: 60_000 });
  } catch (err) {
    await unlink(inputPath).catch(() => {});
    throw new Error(`Infographic rendering failed: ${err.stderr || err.message}`);
  }

  await unlink(inputPath).catch(() => {});
  return outputPath;
}
