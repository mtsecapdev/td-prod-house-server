import { execFile, spawn } from 'node:child_process';
import { writeFile, unlink, mkdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import responseFactory from '../utils/responseFactory.js';
import config from '../config.js';
import {
  insertGenerationDb,
  getGenerationByIdDb,
  updateGenerationDb,
  getAllGenerationsDb,
  deleteGenerationDb,
} from '../db/generationsQueries.js';
import { generateOutline, generateAllSlides } from '../services/deckGenerator.js';
import { generateDocOutline, generateAllSections } from '../services/docGenerator.js';
import { editSlide, editSection } from '../services/editChat.js';
import { craftImagePrompt, generateImageFromPrompt } from '../services/imageGenerator.js';
import { generateInfographic } from '../services/infographicGenerator.js';
import { editInfographic } from '../services/editChat.js';
import { uploadImage as uploadToComfyUI, shutdown as shutdownComfyUI } from '../services/comfyui.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

async function createGeneration(req, res) {
  const { type, brief, sourceDocumentIds, model, settings } = req.body;
  const id = await insertGenerationDb({ type, brief, sourceDocumentIds, model, settings });

  const generation = await getGenerationByIdDb(id);

  if (type === 'deck') {
    await updateGenerationDb(id, { status: 'generating' });
    generateOutline(generation)
      .then((outline) => updateGenerationDb(id, { outline: JSON.stringify(outline), status: 'outline_ready' }))
      .catch((err) => updateGenerationDb(id, { status: 'failed', error: err.message }));
  } else if (type === 'doc') {
    await updateGenerationDb(id, { status: 'generating' });
    generateDocOutline(generation)
      .then((outline) => updateGenerationDb(id, { outline: JSON.stringify(outline), status: 'outline_ready' }))
      .catch((err) => updateGenerationDb(id, { status: 'failed', error: err.message }));
  } else if (type === 'image') {
    await updateGenerationDb(id, { status: 'pending' });
  } else if (type === 'infographic') {
    await updateGenerationDb(id, { status: 'pending' });
  }

  const updated = await getGenerationByIdDb(id);
  res.status(201).json(responseFactory.createJsonResponse({ generation: updated }));
}

async function getGeneration(req, res) {
  const generation = await getGenerationByIdDb(req.params.id);
  res.json(responseFactory.createJsonResponse({ generation }));
}

async function listGenerations(req, res) {
  const generations = await getAllGenerationsDb();
  res.json(responseFactory.createJsonResponse({ generations }));
}

async function updateOutline(req, res) {
  const { outline } = req.body;
  await updateGenerationDb(req.params.id, { outline: JSON.stringify(outline) });
  const generation = await getGenerationByIdDb(req.params.id);
  res.json(responseFactory.createJsonResponse({ generation }));
}

async function generateSlides(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const generation = await getGenerationByIdDb(req.params.id);
    await updateGenerationDb(generation.id, { status: 'generating' });

    send({ phase: 'start', total: generation.outline.slides.length, slides: generation.outline.slides.map((s) => ({ title: s.title, layout: s.layout })) });

    const slides = await generateAllSlides(generation, (progress) => send(progress));

    const updatedOutline = { ...generation.outline, slides };
    await updateGenerationDb(generation.id, {
      outline: JSON.stringify(updatedOutline),
      status: 'done',
    });

    send({ phase: 'done' });
  } catch (err) {
    await updateGenerationDb(req.params.id, { status: 'failed', error: err.message });
    send({ phase: 'error', message: err.message });
  }

  res.end();
}

async function generateSections(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const generation = await getGenerationByIdDb(req.params.id);
    await updateGenerationDb(generation.id, { status: 'generating' });

    send({ phase: 'start', total: generation.outline.sections.length, sections: generation.outline.sections.map((s) => ({ title: s.title, section_type: s.section_type })) });

    const sections = await generateAllSections(generation, (progress) => send(progress));

    const updatedOutline = { ...generation.outline, sections };
    await updateGenerationDb(generation.id, {
      outline: JSON.stringify(updatedOutline),
      status: 'done',
    });

    send({ phase: 'done' });
  } catch (err) {
    await updateGenerationDb(req.params.id, { status: 'failed', error: err.message });
    send({ phase: 'error', message: err.message });
  }

  res.end();
}

async function editSlideChat(req, res) {
  const { instruction, history } = req.body;
  const slideIndex = Number(req.params.slideIndex);
  const updatedContent = await editSlide(req.params.id, slideIndex, instruction, history);
  res.json(responseFactory.createJsonResponse({ slide: updatedContent }));
}

async function editSectionChat(req, res) {
  const { instruction, history } = req.body;
  const sectionIndex = Number(req.params.sectionIndex);
  const updatedContent = await editSection(req.params.id, sectionIndex, instruction, history);
  res.json(responseFactory.createJsonResponse({ section: updatedContent }));
}

async function downloadFile(req, res) {
  const generation = await getGenerationByIdDb(req.params.id);
  const isDeck = generation.type === 'deck';
  const isDoc = generation.type === 'doc';

  if (isDeck && !generation.outline?.slides?.length) {
    return res.status(400).json(responseFactory.createJsonResponse(null, { message: 'No slides generated yet' }));
  }
  if (isDoc && !generation.outline?.sections?.length) {
    return res.status(400).json(responseFactory.createJsonResponse(null, { message: 'No sections generated yet' }));
  }

  const ext = isDeck ? 'pptx' : 'docx';
  const outDir = join(config.outputDir, ext);
  await mkdir(outDir, { recursive: true });

  const inputPath = join(outDir, `${generation.id}_input.json`);
  const outputPath = join(outDir, `${generation.id}.${ext}`);
  const scriptName = isDeck ? 'render_pptx.py' : 'render_docx.py';
  const scriptPath = join(__dirname, '..', '..', 'scripts', scriptName);

  await writeFile(inputPath, JSON.stringify(generation.outline), 'utf-8');

  try {
    await execFileAsync('python', [scriptPath, inputPath, outputPath], { timeout: 30_000 });
  } catch (err) {
    await unlink(inputPath).catch(() => {});
    return res.status(500).json(responseFactory.createJsonResponse(null, {
      message: `${ext.toUpperCase()} rendering failed: ${err.stderr || err.message}`,
    }));
  }

  await unlink(inputPath).catch(() => {});

  const topic = (generation.brief?.topic || generation.type).replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 60).trim();
  res.download(outputPath, `${topic}.${ext}`);
}

async function openInDeckCraft(req, res) {
  const generation = await getGenerationByIdDb(req.params.id);
  if (!generation.outline?.slides?.length) {
    return res.status(400).json(responseFactory.createJsonResponse(null, { message: 'No slides generated yet' }));
  }

  const outDir = join(config.outputDir, 'pptx');
  await mkdir(outDir, { recursive: true });

  const inputPath = join(outDir, `${generation.id}_input.json`);
  const outputPath = join(outDir, `${generation.id}.pptx`);
  const scriptPath = join(__dirname, '..', '..', 'scripts', 'render_pptx.py');

  await writeFile(inputPath, JSON.stringify(generation.outline), 'utf-8');

  try {
    await execFileAsync('python', [scriptPath, inputPath, outputPath], { timeout: 30_000 });
  } catch (err) {
    await unlink(inputPath).catch(() => {});
    return res.status(500).json(responseFactory.createJsonResponse(null, {
      message: `PPTX rendering failed: ${err.stderr || err.message}`,
    }));
  }

  await unlink(inputPath).catch(() => {});

  try {
    await access(config.deckCraftPath);
  } catch {
    return res.status(500).json(responseFactory.createJsonResponse(null, {
      message: `DeckCraft not found at ${config.deckCraftPath}`,
    }));
  }

  const child = spawn(config.deckCraftPath, [outputPath], { detached: true, stdio: 'ignore' });
  child.unref();

  res.json(responseFactory.createJsonResponse({ opened: true, path: outputPath }));
}

async function openInWordCraft(req, res) {
  const generation = await getGenerationByIdDb(req.params.id);
  if (!generation.outline?.sections?.length) {
    return res.status(400).json(responseFactory.createJsonResponse(null, { message: 'No sections generated yet' }));
  }

  const outDir = join(config.outputDir, 'docx');
  await mkdir(outDir, { recursive: true });

  const inputPath = join(outDir, `${generation.id}_input.json`);
  const outputPath = join(outDir, `${generation.id}.docx`);
  const scriptPath = join(__dirname, '..', '..', 'scripts', 'render_docx.py');

  await writeFile(inputPath, JSON.stringify(generation.outline), 'utf-8');

  try {
    await execFileAsync('python', [scriptPath, inputPath, outputPath], { timeout: 30_000 });
  } catch (err) {
    await unlink(inputPath).catch(() => {});
    return res.status(500).json(responseFactory.createJsonResponse(null, {
      message: `DOCX rendering failed: ${err.stderr || err.message}`,
    }));
  }

  await unlink(inputPath).catch(() => {});

  try {
    await access(config.wordCraftPath);
  } catch {
    return res.status(500).json(responseFactory.createJsonResponse(null, {
      message: `WordCraft not found at ${config.wordCraftPath}`,
    }));
  }

  const child = spawn(config.wordCraftPath, [outputPath], { detached: true, stdio: 'ignore' });
  child.unref();

  res.json(responseFactory.createJsonResponse({ opened: true, path: outputPath }));
}

async function uploadReferenceImage(req, res) {
  if (!req.file) {
    return res.status(400).json(responseFactory.createJsonResponse(null, { message: 'No image file provided' }));
  }

  const generation = await getGenerationByIdDb(req.params.id);
  const comfyName = await uploadToComfyUI(req.file.buffer, req.file.originalname);

  const brief = { ...generation.brief, reference_image: comfyName };
  await updateGenerationDb(generation.id, { brief: JSON.stringify(brief) });

  const updated = await getGenerationByIdDb(generation.id);
  res.json(responseFactory.createJsonResponse({ generation: updated, comfyImageName: comfyName }));
}

async function releaseGpu(req, res) {
  const stopped = shutdownComfyUI();
  res.json(responseFactory.createJsonResponse({ released: stopped }));
}

async function craftPrompt(req, res) {
  const generation = await getGenerationByIdDb(req.params.id);
  const promptData = await craftImagePrompt(generation);

  await updateGenerationDb(generation.id, {
    outline: JSON.stringify({ prompt: promptData.prompt, negative_prompt: promptData.negative_prompt }),
    status: 'prompt_ready',
  });

  const updated = await getGenerationByIdDb(generation.id);
  res.json(responseFactory.createJsonResponse({ generation: updated }));
}

async function updatePrompt(req, res) {
  const { prompt, negative_prompt } = req.body;
  const generation = await getGenerationByIdDb(req.params.id);
  const outline = generation.outline || {};

  await updateGenerationDb(generation.id, {
    outline: JSON.stringify({ ...outline, prompt, negative_prompt: negative_prompt || outline.negative_prompt || '' }),
    status: 'prompt_ready',
  });

  const updated = await getGenerationByIdDb(generation.id);
  res.json(responseFactory.createJsonResponse({ generation: updated }));
}

async function generateImageSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const generation = await getGenerationByIdDb(req.params.id);
    await updateGenerationDb(generation.id, { status: 'generating' });

    send({ phase: 'start' });

    const result = await generateImageFromPrompt(generation, (progress) => send(progress));

    await updateGenerationDb(generation.id, {
      outline: JSON.stringify(result),
      status: 'done',
    });

    send({ phase: 'done', image: result });
  } catch (err) {
    await updateGenerationDb(req.params.id, { status: 'failed', error: err.message });
    send({ phase: 'error', message: err.message });
  }

  res.end();
}

async function serveImage(req, res) {
  const generation = await getGenerationByIdDb(req.params.id);
  const filePath = generation.outline?.file_path;
  if (!filePath) {
    return res.status(400).json(responseFactory.createJsonResponse(null, { message: 'No image generated yet' }));
  }

  try {
    await access(filePath);
  } catch {
    return res.status(404).json(responseFactory.createJsonResponse(null, { message: 'Image file not found' }));
  }

  const topic = (generation.brief?.topic || 'image').replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 60).trim();
  res.download(filePath, `${topic}.png`);
}

async function generateInfographicSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const generation = await getGenerationByIdDb(req.params.id);
    await updateGenerationDb(generation.id, { status: 'generating' });

    send({ phase: 'start' });

    const result = await generateInfographic(generation, (progress) => send(progress));

    await updateGenerationDb(generation.id, {
      outline: JSON.stringify(result),
      status: 'done',
    });

    send({ phase: 'done', infographic: result });
  } catch (err) {
    await updateGenerationDb(req.params.id, { status: 'failed', error: err.message });
    send({ phase: 'error', message: err.message });
  }

  res.end();
}

async function editInfographicChat(req, res) {
  const { instruction, history } = req.body;
  const updatedContent = await editInfographic(req.params.id, instruction, history);
  res.json(responseFactory.createJsonResponse({ content: updatedContent }));
}

async function serveInfographic(req, res) {
  const generation = await getGenerationByIdDb(req.params.id);
  const filePath = generation.outline?.file_path;
  if (!filePath) {
    return res.status(400).json(responseFactory.createJsonResponse(null, { message: 'No infographic generated yet' }));
  }

  try {
    await access(filePath);
  } catch {
    return res.status(404).json(responseFactory.createJsonResponse(null, { message: 'Infographic file not found' }));
  }

  const topic = (generation.brief?.topic || 'infographic').replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 60).trim();
  res.download(filePath, `${topic}.png`);
}

async function deleteGeneration(req, res) {
  await deleteGenerationDb(req.params.id);
  res.json(responseFactory.createJsonResponse({ deleted: true }));
}

export default {
  createGeneration,
  getGeneration,
  listGenerations,
  updateOutline,
  generateSlides,
  generateSections,
  editSlideChat,
  editSectionChat,
  downloadFile,
  openInDeckCraft,
  openInWordCraft,
  uploadReferenceImage,
  craftPrompt,
  updatePrompt,
  releaseGpu,
  generateImageSSE,
  serveImage,
  generateInfographicSSE,
  editInfographicChat,
  serveInfographic,
  deleteGeneration,
};
