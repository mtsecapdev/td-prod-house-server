import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import config from '../config.js';
import { generateStructured } from './llm.js';
import { unload as unloadOllama } from './providers/ollama.js';
import { queuePrompt, pollUntilDone, downloadImage, ensureRunning } from './comfyui.js';
import AppError from '../utils/AppError.js';

const IMAGE_PROMPT_SCHEMA = {
  type: 'object',
  required: ['prompt', 'negative_prompt'],
  properties: {
    prompt: { type: 'string', description: 'The vivid visual description of the image to generate — only the scene itself, never the instructions or rules' },
    negative_prompt: { type: 'string', description: 'Comma-separated list of things to avoid' },
  },
  additionalProperties: false,
};

function buildPromptInstruction(brief, sourceContext) {
  const { topic, style, description } = brief;

  let instruction =
    `You are writing an image generation prompt for a text-to-image AI model.\n` +
    `Your "prompt" output must be ONLY a vivid visual description of the scene — do NOT repeat these instructions, rules, or the topic line.\n\n` +
    `Topic: ${topic}\n` +
    (description ? `Description: ${description}\n` : '') +
    (style ? `Style: ${style}\n` : '');

  if (sourceContext) {
    instruction +=
      `\nSource material:\n${sourceContext}\n\n` +
      `Rules:\n` +
      `- The image must accurately represent information from the source material\n` +
      `- For diagrams: describe the layout, connections, labels, and structure clearly\n` +
      `- For infographics: describe the data points, visual hierarchy, icons, and flow\n` +
      `- Describe the visual composition (layout, colors, perspective) in detail\n` +
      `- Keep the prompt under 300 words\n` +
      `- For "negative_prompt", list things to avoid (e.g. "blurry, low quality, cluttered")\n` +
      `- Do NOT include readable text in the image — describe shapes, icons, and visual elements instead\n`;
  } else {
    instruction +=
      `\nRules:\n` +
      `- Write a vivid, specific description of the image (composition, lighting, colors, perspective)\n` +
      `- Include the style in the prompt naturally\n` +
      `- Keep the prompt under 200 words\n` +
      `- For "negative_prompt", list things to avoid (e.g. "blurry, low quality, text, watermark")\n` +
      `- Do NOT include any text overlays or words in the image description\n`;
  }

  return instruction;
}

const SIZES = {
  square: { width: 1024, height: 1024 },
  landscape: { width: 1344, height: 768 },
  portrait: { width: 768, height: 1344 },
  wide: { width: 1536, height: 640 },
};

export async function craftImagePrompt(generation) {
  const { brief } = generation;
  const promptInstruction = buildPromptInstruction(brief, '');
  return generateStructured(
    promptInstruction, config.ollama.generateModel, IMAGE_PROMPT_SCHEMA, { think: false },
  );
}

export async function generateImageFromPrompt(generation, onProgress) {
  const { brief } = generation;
  const size = SIZES[brief.size] || SIZES.square;
  const promptText = generation.outline?.prompt;
  if (!promptText) throw new AppError('No image prompt found — craft a prompt first', 400);

  onProgress({ phase: 'switching', message: 'Preparing GPU for image generation...' });

  await unloadOllama(config.ollama.generateModel);
  await ensureRunning();

  onProgress({ phase: 'generating', message: 'Generating image...' });

  const referenceImage = brief.reference_image;
  const denoise = brief.strength != null ? brief.strength : 0.65;

  const promptOpts = {
    width: size.width,
    height: size.height,
    steps: referenceImage ? 8 : 8,
  };

  if (referenceImage) {
    promptOpts.imageName = referenceImage;
    promptOpts.denoise = denoise;
  }

  const promptId = await queuePrompt(promptText, promptOpts);

  const images = await pollUntilDone(promptId, { timeout: 120_000 });
  const img = images[0];

  onProgress({ phase: 'saving', message: 'Saving image...' });

  const imageBuffer = await downloadImage(img.filename, img.subfolder, img.type);

  const outDir = join(config.outputDir, 'images');
  await mkdir(outDir, { recursive: true });
  const outputPath = join(outDir, `${generation.id}.png`);
  await writeFile(outputPath, imageBuffer);

  return {
    prompt: promptText,
    negative_prompt: generation.outline?.negative_prompt || '',
    size: brief.size || 'square',
    width: size.width,
    height: size.height,
    file_path: outputPath,
  };
}
