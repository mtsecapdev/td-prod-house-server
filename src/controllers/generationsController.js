import { spawn } from 'node:child_process';
import { access, rename, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import responseFactory from '../utils/responseFactory.js';
import config from '../config.js';
import AppError from '../utils/AppError.js';
import {
  insertGenerationDb,
  getGenerationByIdDb,
  updateGenerationDb,
  getAllGenerationsDb,
  deleteGenerationDb,
  claimJobDb,
  heartbeatJobDb,
  failJobDb,
  isJobLive,
} from '../db/generationsQueries.js';
import { kindOf } from '../services/planning/kinds.js';
import {
  generateQuestions, generateStoryline, generateOutline, attachSources, searchSources,
} from '../services/planning/planner.js';
import { writeAll, writeItem } from '../services/planning/writer.js';
import { startJob } from '../services/jobs.js';
import { editSlide, editSection } from '../services/editChat.js';
import { craftImagePrompt, generateImageFromPrompt } from '../services/imageGenerator.js';
import { renderDiagram, diagramPath, deleteDiagrams, DiagramSyntaxError } from '../services/diagrams.js';
import { renderOfficeFile, notReadyMessage, officeExt, downloadName } from '../services/officeRenderer.js';
import { uploadImage as uploadToComfyUI, shutdown as shutdownComfyUI } from '../services/comfyui.js';

async function createGeneration(req, res) {
  const { type, brief, sourceDocumentIds, model, settings } = req.body;
  const id = await insertGenerationDb({ type, brief, sourceDocumentIds, model, settings });

  const generation = await getGenerationByIdDb(id);

  if (type === 'deck' || type === 'doc') {
    await updateGenerationDb(id, { status: 'brief', brief: JSON.stringify(normalizeBrief(brief)) });
    const fresh = await getGenerationByIdDb(id);
    await startQuestionsJob(fresh);
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

// ── Planning: brief -> clarifying questions -> storyline -> outline ──

const BRIEF_FIELDS = ['topic', 'purpose', 'audience', 'audience_level', 'format', 'tone', 'length', 'include', 'exclude', 'notes'];

function normalizeBrief(input = {}, previous = {}) {
  const brief = { ...previous };
  for (const f of BRIEF_FIELDS) if (input[f] !== undefined) brief[f] = typeof input[f] === 'string' ? input[f].trim() : input[f];
  if (Array.isArray(input.questions)) {
    brief.questions = input.questions.map((q) => ({
      question: String(q.question || ''), why: String(q.why || ''),
      options: Array.isArray(q.options) ? q.options.map(String) : [], answer: String(q.answer || ''),
    }));
  }
  if (!brief.questions) brief.questions = [];
  return brief;
}

async function getPlannable(id) {
  const generation = await getGenerationByIdDb(id);
  kindOf(generation); // throws for images
  return generation;
}

function busy(res, generation) {
  return res.status(409).json(responseFactory.createJsonResponse(null, {
    message: `Still working on the ${generation.job?.kind || 'previous step'}. Try again when it finishes.`,
  }));
}

async function startQuestionsJob(generation) {
  return startJob(generation.id, 'questions', async () => {
    const questions = await generateQuestions(generation);
    const latest = await getGenerationByIdDb(generation.id);
    return { brief: JSON.stringify({ ...latest.brief, questions }) };
  });
}

// Marks a written outline as out of date when the storyline it was built from changes.
function staleOutline(generation) {
  const kind = kindOf(generation);
  const items = generation.outline?.[kind.listKey];
  return items?.length ? JSON.stringify({ ...generation.outline, stale: true }) : undefined;
}

async function updateBrief(req, res) {
  const generation = await getPlannable(req.params.id);
  const brief = normalizeBrief(req.body.brief, generation.brief);
  await updateGenerationDb(generation.id, { brief: JSON.stringify(brief) });
  res.json(responseFactory.createJsonResponse({ generation: await getGenerationByIdDb(generation.id) }));
}

async function regenerateQuestions(req, res) {
  const generation = await getPlannable(req.params.id);
  if (!(await startQuestionsJob(generation))) return busy(res, generation);
  res.status(202).json(responseFactory.createJsonResponse({ generation: await getGenerationByIdDb(generation.id) }));
}

async function createStoryline(req, res) {
  const generation = await getPlannable(req.params.id);
  const instruction = (req.body?.instruction || '').trim() || undefined;
  const started = await startJob(generation.id, 'storyline', async () => {
    const storyline = await generateStoryline(generation, { instruction });
    const latest = await getGenerationByIdDb(generation.id);
    const outline = staleOutline(latest);
    return {
      storyline: JSON.stringify(storyline),
      status: ['outline_ready', 'writing', 'done'].includes(latest.status) ? latest.status : 'storyline_ready',
      ...(outline ? { outline } : {}),
    };
  });
  if (!started) return busy(res, generation);
  res.status(202).json(responseFactory.createJsonResponse({ generation: await getGenerationByIdDb(generation.id) }));
}

async function updateStoryline(req, res) {
  const generation = await getPlannable(req.params.id);
  const s = req.body.storyline || {};
  const storyline = {
    thesis: String(s.thesis || ''),
    arc: String(s.arc || ''),
    messages: (s.messages || []).map((m, i) => ({
      id: m.id || `m${i + 1}`, text: String(m.text || ''),
      section_ids: (m.section_ids || []).map(Number).filter(Number.isFinite),
      sections: (m.sections || []).map((x) => ({ id: Number(x.id), heading: String(x.heading || ''), page: x.page ?? null })),
    })).filter((m) => m.text.trim()),
    out_of_scope: (s.out_of_scope || []).map((o) => ({ section: String(o.section || ''), reason: String(o.reason || '') })),
    generated_at: generation.storyline?.generated_at,
    edited_at: new Date().toISOString(),
  };
  const outline = staleOutline(generation);
  await updateGenerationDb(generation.id, {
    storyline: JSON.stringify(storyline),
    status: generation.status === 'brief' ? 'storyline_ready' : generation.status,
    ...(outline ? { outline } : {}),
  });
  res.json(responseFactory.createJsonResponse({ generation: await getGenerationByIdDb(generation.id) }));
}

async function createOutline(req, res) {
  const generation = await getPlannable(req.params.id);
  if (!generation.storyline?.messages?.length) {
    throw new AppError('Create the storyline first', 400);
  }
  const instruction = (req.body?.instruction || '').trim() || undefined;
  const started = await startJob(generation.id, 'outline', async () => {
    const outline = await generateOutline(generation, { instruction });
    return { outline: JSON.stringify(outline), status: 'outline_ready' };
  });
  if (!started) return busy(res, generation);
  res.status(202).json(responseFactory.createJsonResponse({ generation: await getGenerationByIdDb(generation.id) }));
}

// Re-finds the unpinned sources of one outline item (after its point changed, or for a new item).
async function refreshItemSources(req, res) {
  const generation = await getPlannable(req.params.id);
  const kind = kindOf(generation);
  const index = Number(req.params.index);
  const item = req.body?.item || generation.outline?.[kind.listKey]?.[index];
  if (!item) throw new AppError(`${kind.noun} ${index + 1} not found`, 404);
  const copy = { ...item, locked: false, sources: (item.sources || []).filter((s) => s.pinned) };
  await attachSources(generation, { ...kind, noSourceTypes: [] }, [copy]);
  res.json(responseFactory.createJsonResponse({ sources: copy.sources }));
}

async function findSources(req, res) {
  const generation = await getPlannable(req.params.id);
  const q = String(req.query.q || '').trim();
  if (!q) return res.json(responseFactory.createJsonResponse({ sources: [] }));
  res.json(responseFactory.createJsonResponse({ sources: await searchSources(generation, q) }));
}

// ── Writing ──
// One endpoint per kind (POST /generate for decks, /generate-sections for documents), same behaviour:
// starts writing, or, if a write is already running (another tab, a reload), streams that one's progress.
// Writing continues if the client disconnects; a run cut off by a restart resumes where it stopped.

const WATCH_INTERVAL_MS = 2000;

async function writeSSE(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  let open = true;
  req.on('close', () => { open = false; });
  const send = (data) => { if (open) res.write(`data: ${JSON.stringify(data)}\n\n`); };

  const generation = await getPlannable(req.params.id).catch((err) => { send({ phase: 'error', message: err.message }); return null; });
  if (!generation) return res.end();
  const kind = kindOf(generation);
  const items = generation.outline?.[kind.listKey] || [];
  if (!items.length) { send({ phase: 'error', message: `The outline has no ${kind.nounPlural}` }); return res.end(); }

  send({ phase: 'start', total: items.length, [kind.listKey]: items.map((it) => ({ title: it.title, [kind.typeKey]: it[kind.typeKey] })) });

  const claimed = !isJobLive(generation.job) && await claimJobDb(generation.id, 'write');
  if (!claimed) {
    await watchWrite(generation.id, kind, send, () => open);
    return res.end();
  }

  try {
    const resume = ['writing', 'generating'].includes(generation.status);
    await updateGenerationDb(generation.id, { status: 'writing' });
    const written = await writeAll(generation, {
      resume,
      onProgress: async (progress) => {
        send(progress);
        await heartbeatJobDb(generation.id, { done: progress.done, total: progress.total, title: progress.title });
      },
      onItemDone: (soFar) => updateGenerationDb(generation.id, {
        outline: JSON.stringify({ ...generation.outline, [kind.listKey]: soFar }),
      }),
    });
    await updateGenerationDb(generation.id, {
      outline: JSON.stringify({ ...generation.outline, [kind.listKey]: written }),
      status: 'done',
      job: null,
    });
    send({ phase: 'done' });
  } catch (err) {
    console.error(`Generation ${generation.id}: writing failed: ${err.message}`);
    // Status stays 'writing' so retrying resumes from the last finished item.
    await failJobDb(generation.id, 'write', err.message);
    send({ phase: 'error', message: err.message });
  }
  res.end();
}

async function watchWrite(id, kind, send, isOpen) {
  let lastDone = -1;
  while (isOpen()) {
    const g = await getGenerationByIdDb(id);
    if (g.status === 'done' && !g.job) { send({ phase: 'done' }); return; }
    if (g.job?.state === 'failed') { send({ phase: 'error', message: g.job.error }); return; }
    if (!isJobLive(g.job)) { send({ phase: 'error', message: 'Writing stopped unexpectedly. Retry to continue where it left off.' }); return; }
    const p = g.job.progress;
    if (p && p.done !== lastDone) {
      lastDone = p.done;
      send({ phase: kind.noun, [kind.noun]: p.done + 1, total: p.total, title: p.title });
    }
    await new Promise((r) => setTimeout(r, WATCH_INTERVAL_MS));
  }
}

// Rewrites one slide/section from its plan, optionally with a note from the user.
async function regenerateItem(req, res) {
  const generation = await getPlannable(req.params.id);
  const kind = kindOf(generation);
  const index = Number(req.params.index);
  const items = generation.outline?.[kind.listKey] || [];
  const item = items[index];
  if (!item) throw new AppError(`${kind.noun} ${index + 1} not found`, 404);
  if (isJobLive(generation.job)) return busy(res, generation);

  const note = typeof req.body?.note === 'string' ? req.body.note.trim() : undefined;
  const { type, content, sources } = await writeItem(generation, index, { note });

  const latest = await getGenerationByIdDb(generation.id);
  const latestItems = [...latest.outline[kind.listKey]];
  latestItems[index] = { ...latestItems[index], [kind.typeKey]: type, content, sources, ...(note !== undefined ? { note } : {}) };
  const indexKey = kind.name === 'deck' ? 'slide_index' : 'section_index';
  await updateGenerationDb(generation.id, {
    outline: JSON.stringify({ ...latest.outline, [kind.listKey]: latestItems }),
    edit_history: [...(latest.edit_history || []), {
      [indexKey]: index, instruction: note ? `Regenerate: ${note}` : 'Regenerate', before: item.content, timestamp: new Date().toISOString(),
    }],
  });
  res.json(responseFactory.createJsonResponse({ item: latestItems[index] }));
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
  updateBrief,
  regenerateQuestions,
  createStoryline,
  updateStoryline,
  createOutline,
  refreshItemSources,
  findSources,
  writeSSE,
  regenerateItem,
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
