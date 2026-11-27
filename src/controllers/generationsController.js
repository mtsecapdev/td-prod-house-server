import { spawn } from 'node:child_process';
import { access, rename, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import responseFactory from '../utils/responseFactory.js';
import config from '../config.js';
import AppError from '../utils/AppError.js';
import {
  getGenerationByIdDb, updateGenerationDb, getAllGenerationsDb, deleteGenerationDb, claimJobDb, heartbeatJobDb, failJobDb, isJobLive, presentGeneration, withHeartbeat,
} from '../db/generationsQueries.js';
import { kindOf } from '../services/planning/kinds.js';
import { attachSources, searchSources, suggestTypes } from '../services/planning/planner.js';
import { writeAll } from '../services/planning/writer.js';
import { rewriteItem, placeFigure } from '../services/planning/itemOps.js';
import { startJob } from '../services/jobs.js';
import { normalizeBrief, startOutlineJob } from '../services/planning/outlineJob.js';
import { runImageJob } from '../services/imageSkill.js';
import { renderDiagram, ensureDiagramFile, deleteDiagrams, DiagramSyntaxError } from '../services/diagrams.js';
import { listTemplates, createBrandTemplate, deleteBrandTemplate } from '../services/templates.js';
import { getBrandTemplateDb } from '../db/brandTemplatesQueries.js';
import { ownFigureIds } from '../middleware/auth.js';
import { renderOfficeFile, notReadyMessage, officeExt, downloadName } from '../services/officeRenderer.js';
import { openEventStream } from '../utils/eventStream.js';

async function getTemplates(req, res) {
  res.json(responseFactory.createJsonResponse(await listTemplates()));
}

// Upload a company .pptx: its theme colours and fonts become a template, and decks build on its masters.
async function uploadTemplate(req, res) {
  if (!req.file) throw new AppError('Choose a .pptx file', 400);
  if (!/\.pptx$/i.test(req.file.originalname)) throw new AppError('Templates must be PowerPoint .pptx files', 400);
  const name = String(req.body?.name || req.file.originalname.replace(/\.pptx$/i, '')).trim().slice(0, 60) || 'Company template';
  const template = await createBrandTemplate(req.file.buffer, name, req.user.id);
  res.status(201).json(responseFactory.createJsonResponse({ template }));
}

// Templates are shared by everyone; the person who uploaded one (or an admin) can delete it.
async function removeTemplate(req, res) {
  const template = await getBrandTemplateDb(Number(req.params.templateId) || 0);
  if (!template) throw new AppError('Template not found', 404);
  if (template.uploaded_by !== req.user.id && req.user.role !== 'admin') {
    throw new AppError('Only the person who added this template, or an admin, can delete it', 403);
  }
  const deleted = await deleteBrandTemplate(template.id);
  if (!deleted) throw new AppError('Template not found', 404);
  res.json(responseFactory.createJsonResponse({ deleted: true }));
}

async function getGeneration(req, res) {
  const generation = presentGeneration(await getGenerationByIdDb(req.params.id));
  res.json(responseFactory.createJsonResponse({ generation }));
}

async function listGenerations(req, res) {
  const generations = (await getAllGenerationsDb(req.user.id)).map(presentGeneration);
  res.json(responseFactory.createJsonResponse({ generations }));
}

async function updateOutline(req, res) {
  const { outline } = req.body;
  await updateGenerationDb(req.params.id, { outline: JSON.stringify(outline) });
  const generation = await getGenerationByIdDb(req.params.id);
  res.json(responseFactory.createJsonResponse({ generation }));
}

// ── Planning (Gamma-style): prompt -> outline (one job) -> settings ──

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

// Settings on the outline screen (text amount, audience, tone, format, instructions). They apply when
// writing, so changing them never rebuilds the outline.
async function updateBrief(req, res) {
  const generation = await getPlannable(req.params.id);
  const brief = normalizeBrief(req.body.brief, generation.brief);
  await updateGenerationDb(generation.id, { brief: JSON.stringify(brief) });
  res.json(responseFactory.createJsonResponse({ generation: await getGenerationByIdDb(generation.id) }));
}

// The deck's/document's own name, separate from its title slide's title. An empty name goes back to following
// the title slide.
const MAX_NAME = 120;
async function renameGeneration(req, res) {
  const generation = await getPlannable(req.params.id);
  const name = String(req.body?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  await updateGenerationDb(generation.id, { name: name || null });
  res.json(responseFactory.createJsonResponse({ generation: presentGeneration(await getGenerationByIdDb(generation.id)) }));
}

async function createOutline(req, res) {
  const generation = await getPlannable(req.params.id);
  if (req.body?.brief) {
    await updateGenerationDb(generation.id, { brief: JSON.stringify(normalizeBrief(req.body.brief, generation.brief)) });
  }
  if (!(await startOutlineJob(await getGenerationByIdDb(generation.id)))) return busy(res, generation);
  res.status(202).json(responseFactory.createJsonResponse({ generation: await getGenerationByIdDb(generation.id) }));
}

// Re-finds the sources of one outline item from its current title and bullets; sources the user added stay.
async function refreshItemSources(req, res) {
  const generation = await getPlannable(req.params.id);
  const kind = kindOf(generation);
  const index = Number(req.params.index);
  const item = req.body?.item || generation.outline?.[kind.listKey]?.[index];
  if (!item) throw new AppError(`${kind.noun} ${index + 1} not found`, 404);
  const copy = { ...item, sources: (item.sources || []).filter((s) => s.added) };
  await attachSources(generation, kind, [copy], { force: true });
  res.json(responseFactory.createJsonResponse({ sources: copy.sources }));
}

async function findSources(req, res) {
  const generation = await getPlannable(req.params.id);
  const q = String(req.query.q || '').trim();
  if (!q) return res.json(responseFactory.createJsonResponse({ sources: [] }));
  res.json(responseFactory.createJsonResponse({ sources: await searchSources(generation, q) }));
}

// ── Writing ──
// POST /:id/write writes every slide/section that has no content yet: the whole deck after planning, or the
// items the user changed in the outline afterwards. If a write is already running (another tab, a reload),
// it streams that one instead. Writing continues if the client disconnects.

const WATCH_INTERVAL_MS = 2000;

async function writeSSE(req, res) {
  const { send, isOpen, end } = openEventStream(res);

  const generation = await getPlannable(req.params.id).catch((err) => { send({ phase: 'error', message: err.message }); return null; });
  if (!generation) return end();
  const kind = kindOf(generation);
  const items = generation.outline?.[kind.listKey] || [];
  if (!items.length) { send({ phase: 'error', message: `The outline has no ${kind.nounPlural}` }); return end(); }

  send({ phase: 'start', total: items.length, [kind.listKey]: items.map((it) => ({ title: it.title, [kind.typeKey]: it[kind.typeKey] })) });

  const claimed = !isJobLive(generation.job) && await claimJobDb(generation.id, 'write');
  if (!claimed) {
    await watchWrite(generation.id, kind, send, isOpen);
    return end();
  }

  try {
    await updateGenerationDb(generation.id, { status: 'writing' });
    const written = await withHeartbeat(generation.id, () => writeAll(generation, {
      onProgress: async (progress) => {
        send(progress);
        await heartbeatJobDb(generation.id, { done: progress.done, total: progress.total, title: progress.title });
      },
      onItemDone: async (soFar, index) => {
        await updateGenerationDb(generation.id, { outline: JSON.stringify({ ...generation.outline, [kind.listKey]: soFar }) });
        send({ phase: 'item_done', index, item: soFar[index] });
      },
    }));
    await updateGenerationDb(generation.id, {
      outline: JSON.stringify({ ...generation.outline, [kind.listKey]: written }),
      status: 'done',
      job: null,
    });
    send({ phase: 'done' });
  } catch (err) {
    console.error(`Generation ${generation.id}: writing failed: ${err.message}`);
    // Status stays 'writing'; retrying continues from the first item without content.
    await failJobDb(generation.id, 'write', err.message);
    send({ phase: 'error', message: err.message });
  }
  end();
}

// Streams a write that another request is running: progress, and each item as it lands in the database.
async function watchWrite(id, kind, send, isOpen) {
  const sent = new Set();
  while (isOpen()) {
    const g = await getGenerationByIdDb(id);
    (g.outline?.[kind.listKey] || []).forEach((item, index) => {
      if (item.content && !sent.has(item.id ?? index)) {
        sent.add(item.id ?? index);
        send({ phase: 'item_done', index, item });
      }
    });
    if (g.status === 'done' && !g.job) { send({ phase: 'done' }); return; }
    if (g.job?.state === 'failed') { send({ phase: 'error', message: g.job.error }); return; }
    if (!isJobLive(g.job)) { send({ phase: 'error', message: 'Writing stopped unexpectedly. Retry to continue where it left off.' }); return; }
    const p = g.job.progress;
    if (p) send({ phase: kind.noun, [kind.noun]: p.done + 1, total: p.total, title: p.title });
    await new Promise((r) => setTimeout(r, WATCH_INTERVAL_MS));
  }
}

// Rewrites one slide/section from its plan, optionally with a note or a different layout.
async function regenerateItem(req, res) {
  const generation = await getPlannable(req.params.id);
  const kind = kindOf(generation);
  const index = Number(req.params.index);
  if (!generation.outline?.[kind.listKey]?.[index]) throw new AppError(`${kind.noun} ${index + 1} not found`, 404);
  if (isJobLive(generation.job)) return busy(res, generation);

  const note = typeof req.body?.note === 'string' ? req.body.note.trim() : undefined;
  const item = await rewriteItem(generation.id, index, { note, type: req.body?.type });
  res.json(responseFactory.createJsonResponse({ item }));
}

// Remix: the best other layouts for one slide/section, with reasons.
async function suggestLayouts(req, res) {
  const generation = await getPlannable(req.params.id);
  const suggestions = await suggestTypes(generation, Number(req.params.index));
  res.json(responseFactory.createJsonResponse({ suggestions }));
}

// Puts a document figure into the deck/document: { figureId, index, mode: 'replace' | 'after' }.
async function addFigure(req, res) {
  const generation = await getPlannable(req.params.id);
  if (isJobLive(generation.job)) return busy(res, generation);
  const figureId = Number(req.body?.figureId);
  if (!figureId) throw new AppError('Choose a figure', 400);
  if (!(await ownFigureIds(req.user.id, [figureId])).length) throw new AppError('Figure not found', 404);
  const kind = kindOf(generation);
  const items = generation.outline?.[kind.listKey] || [];
  // Without a position (e.g. "Use in..." from Assets), the figure goes before the closing slide/summary.
  const last = items.length - 1;
  const defaultAfter = items[last]?.[kind.typeKey] === kind.lastType ? last - 1 : last;
  const index = Math.min(Math.max(Number(req.body?.index ?? defaultAfter), 0), Math.max(last, 0));
  res.status(201).json(responseFactory.createJsonResponse(await placeFigure(generation.id, figureId, index)));
}

// ── Deck-wide agent ──

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
  const generation = await getGenerationByIdDb(req.params.id);
  try {
    const key = await renderDiagram(generation, code);
    res.json(responseFactory.createJsonResponse({ diagram_file: key }));
  } catch (err) {
    if (err instanceof DiagramSyntaxError) {
      return res.status(422).json(responseFactory.createJsonResponse(null, { message: err.message }));
    }
    throw err;
  }
}

async function serveDiagram(req, res) {
  const generation = await getGenerationByIdDb(req.params.id);
  // ?template= picks the colours (the client passes the deck's template, which also busts the browser cache).
  const template = String(req.query.template || generation.brief?.template || '');
  const filePath = await ensureDiagramFile({ ...generation, brief: { ...generation.brief, template } }, req.params.key);
  if (!filePath) return res.status(404).json(responseFactory.createJsonResponse(null, { message: 'Diagram not found' }));
  if (req.query.download) {
    const name = String(req.query.name || 'diagram').replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 60).trim() || 'diagram';
    return res.download(filePath, `${name}.png`);
  }
  // Content-addressed: a key's image never changes.
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(filePath);
}

// Retries an image that failed (e.g. ComfyUI was not running): generates it again in the background.
async function retryImage(req, res) {
  const generation = await getGenerationByIdDb(req.params.id);
  if (generation.type !== 'image') throw new AppError('Not an image', 400);
  if (!(await runImageJob(generation.id))) return busy(res, generation);
  await updateGenerationDb(generation.id, { status: 'generating' });
  res.status(202).json(responseFactory.createJsonResponse({ generation: presentGeneration(await getGenerationByIdDb(generation.id)) }));
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
  retryImage,
  getGeneration,
  getTemplates,
  uploadTemplate,
  removeTemplate,
  listGenerations,
  updateOutline,
  updateBrief,
  renameGeneration,
  createOutline,
  refreshItemSources,
  findSources,
  writeSSE,
  regenerateItem,
  suggestLayouts,
  addFigure,
  downloadFile,
  openInDeckCraft,
  openInWordCraft,
  serveImage,
  renderDiagramCode,
  serveDiagram,
  deleteGeneration,
};
