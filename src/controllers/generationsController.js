import { spawn } from 'node:child_process';
import { access, rename, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
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
import { renderDiagram, diagramPath, deleteDiagrams, DiagramSyntaxError } from '../services/diagrams.js';
import { renderOfficeFile, notReadyMessage, officeExt, downloadName } from '../services/officeRenderer.js';
import { uploadImage as uploadToComfyUI, shutdown as shutdownComfyUI } from '../services/comfyui.js';

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
    // Still 'generating' means the last run was cut off (closed tab, server restart): keep the slides it finished.
    const resume = generation.status === 'generating';
    await updateGenerationDb(generation.id, { status: 'generating' });

    send({ phase: 'start', total: generation.outline.slides.length, slides: generation.outline.slides.map((s) => ({ title: s.title, layout: s.layout })) });

    const slides = await generateAllSlides(generation, {
      resume,
      onProgress: (progress) => send(progress),
      // Save after every slide so progress survives a dropped connection or restart.
      onSlideDone: (soFar) => updateGenerationDb(generation.id, { outline: JSON.stringify({ ...generation.outline, slides: soFar }) }),
    });

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
    // Still 'generating' means the last run was cut off (closed tab, server restart): keep the sections it finished.
    const resume = generation.status === 'generating';
    await updateGenerationDb(generation.id, { status: 'generating' });

    send({ phase: 'start', total: generation.outline.sections.length, sections: generation.outline.sections.map((s) => ({ title: s.title, section_type: s.section_type })) });

    const sections = await generateAllSections(generation, {
      resume,
      onProgress: (progress) => send(progress),
      // Save after every section so progress survives a dropped connection or restart.
      onSectionDone: (soFar) => updateGenerationDb(generation.id, { outline: JSON.stringify({ ...generation.outline, sections: soFar }) }),
    });

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
  const notReady = notReadyMessage(generation);
  if (notReady) return res.status(400).json(responseFactory.createJsonResponse(null, { message: notReady }));

  let outputPath;
  try {
    outputPath = await renderOfficeFile(generation, 'temp');
  } catch (err) {
    return res.status(500).json(responseFactory.createJsonResponse(null, { message: err.message }));
  }
  res.download(outputPath, downloadName(generation, officeExt(generation)), () => {
    unlink(outputPath).catch(() => {});
  });
}

// Renders the file and opens it in a desktop editor (DeckCraft / WordCraft) on the machine running the server.
async function openInDesktopApp(req, res, appPath, appName) {
  const generation = await getGenerationByIdDb(req.params.id);
  const notReady = notReadyMessage(generation);
  if (notReady) return res.status(400).json(responseFactory.createJsonResponse(null, { message: notReady }));

  try {
    await access(appPath);
  } catch {
    return res.status(500).json(responseFactory.createJsonResponse(null, { message: `${appName} not found at ${appPath}` }));
  }

  let outputPath;
  try {
    const ext = officeExt(generation);
    const tempPath = await renderOfficeFile(generation, 'temp');
    // A stable name per generation, so reopening replaces the previous copy instead of piling up files.
    const dir = join(config.outputDir, ext);
    await mkdir(dir, { recursive: true });
    outputPath = join(dir, `${generation.id}.${ext}`);
    await rename(tempPath, outputPath);
  } catch (err) {
    return res.status(500).json(responseFactory.createJsonResponse(null, { message: err.message }));
  }

  const child = spawn(appPath, [outputPath], { detached: true, stdio: 'ignore' });
  child.unref();
  res.json(responseFactory.createJsonResponse({ opened: true, path: outputPath }));
}

const openInDeckCraft = (req, res) => openInDesktopApp(req, res, config.deckCraftPath, 'DeckCraft');
const openInWordCraft = (req, res) => openInDesktopApp(req, res, config.wordCraftPath, 'WordCraft');

// Renders Mermaid typed by the user (Review "Edit code"). Saving the slide/section is left to the client's
// normal outline save, which keeps undo working.
async function renderDiagramCode(req, res) {
  const { mermaid_code: code } = req.body;
  await getGenerationByIdDb(req.params.id); // 404s for unknown generations
  try {
    const key = await renderDiagram(req.params.id, code);
    res.json(responseFactory.createJsonResponse({ diagram_file: key }));
  } catch (err) {
    if (err instanceof DiagramSyntaxError) {
      return res.status(422).json(responseFactory.createJsonResponse(null, { message: err.message }));
    }
    throw err;
  }
}

async function serveDiagram(req, res) {
  const filePath = diagramPath(req.params.id, req.params.key);
  if (!filePath) return res.status(400).json(responseFactory.createJsonResponse(null, { message: 'Invalid diagram id' }));
  try {
    await access(filePath);
  } catch {
    return res.status(404).json(responseFactory.createJsonResponse(null, { message: 'Diagram not found' }));
  }
  if (req.query.download) {
    const name = String(req.query.name || 'diagram').replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 60).trim() || 'diagram';
    return res.download(filePath, `${name}.png`);
  }
  // Content-addressed: a key's image never changes.
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(filePath);
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

async function deleteGeneration(req, res) {
  await deleteGenerationDb(req.params.id);
  await deleteDiagrams(req.params.id);
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
  renderDiagramCode,
  serveDiagram,
  deleteGeneration,
};
