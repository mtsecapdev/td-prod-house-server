// Figures from ingested documents as assets: list/search, image, caption/description edits, and bulk download,
// usage check, delete.
// Bulk actions take a list of ids so the Assets page acts on a selection in one request.
import { unlink } from 'node:fs/promises';
import config from '../config.js';
import responseFactory from '../utils/responseFactory.js';
import AppError from '../utils/AppError.js';
import { writeZip } from '../utils/zip.js';
import {
  listFiguresDb, getFigureByIdDb, deleteFiguresDb, figureUsageDb, getFiguresForDownloadDb, updateFigureDb,
} from '../db/figuresQueries.js';
import { ownFigureIds } from '../middleware/auth.js';
import { describeOne } from '../services/figureDescriptions.js';

const MAX_BULK = 500;

function toPublic(f) {
  const { file_path: _p, key: _k, ...rest } = f;
  return rest;
}

/** Ids from a JSON body ({ ids: [...] }) or a query string (?ids=1,2,3), kept to figures of the user's documents. */
async function idsFrom(req, value) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  const ids = [...new Set(list.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw new AppError('Choose at least one figure', 400);
  if (ids.length > MAX_BULK) throw new AppError(`At most ${MAX_BULK} figures at a time`, 400);
  const mine = await ownFigureIds(req.user.id, ids);
  if (!mine.length) throw new AppError('Those figures no longer exist', 404);
  return mine;
}

async function listFigures(req, res) {
  const documentIds = String(req.query.documentIds || '').split(',').map(Number).filter(Number.isInteger).filter(Boolean);
  const figures = await listFiguresDb({ q: req.query.q, documentIds, ownerId: req.user.id });
  // canDescribe: whether the model can describe a figure again (a vision model is set).
  res.json(responseFactory.createJsonResponse({ figures: figures.map(toPublic), canDescribe: Boolean(config.ollama.visionModel) }));
}

async function serveImage(req, res) {
  const figure = await getFigureByIdDb(Number(req.params.id));
  if (!figure || !(await ownFigureIds(req.user.id, [figure.id])).length) throw new AppError('Figure not found', 404);
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(figure.file_path);
}

// File names inside the zip: "<document>/p12 Figure 2-1 Cylinder, piston....png", unique within the archive.
function zipNames(figures) {
  const clean = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const used = new Set();
  return figures.map((f) => {
    const folder = clean(f.document_name.replace(/\.[a-z0-9]+$/i, '')).slice(0, 80) || 'document';
    const caption = clean(f.caption).slice(0, 80).replace(/[.\s]+$/, '');
    const base = `${f.page != null ? `p${f.page} ` : ''}${caption || `figure ${f.id}`}`.trim();
    let name = `${folder}/${base}.png`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${folder}/${base} (${n}).png`;
    used.add(name.toLowerCase());
    return { name, path: f.file_path };
  });
}

// GET so the browser can download it as a plain link: /figures/download?ids=1,2,3
async function downloadFigures(req, res) {
  const figures = await getFiguresForDownloadDb(await idsFrom(req, req.query.ids));
  if (!figures.length) throw new AppError('Those figures no longer exist', 404);
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="figures-${figures.length}.zip"`);
  await writeZip(res, zipNames(figures));
  res.end();
}

async function getUsage(req, res) {
  res.json(responseFactory.createJsonResponse({ usage: await figureUsageDb(await idsFrom(req, req.body?.ids)) }));
}

// Deleting figures that decks or documents use needs force: true; without it the response lists where they are
// used so the client can warn first. Slides that used them then show "Figure removed".
async function deleteFigures(req, res) {
  const ids = await idsFrom(req, req.body?.ids);
  const usage = await figureUsageDb(ids);
  if (usage.length && req.body?.force !== true) {
    return res.status(409).json(responseFactory.createJsonResponse({ usage }, {
      message: `Used in ${usage.length} place${usage.length === 1 ? '' : 's'}`,
    }));
  }
  const files = await deleteFiguresDb(ids);
  await Promise.all(files.map((f) => unlink(f).catch(() => {})));
  res.json(responseFactory.createJsonResponse({ deleted: files.length, removedFrom: usage.length }));
}

const MAX_CAPTION = 300;
const MAX_DESCRIPTION = 2000;

const text = (value, max, name) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new AppError(`${name} must be text`, 400);
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length > max) throw new AppError(`${name} can be at most ${max} characters`, 400);
  return clean;
};

/**
 * A person's corrections to a figure of their own documents: body { caption?, description? }, marked as
 * checked. Or { redescribe: true }: the model looks at the figure again now (~10-20 s) and its description
 * replaces the current one.
 */
async function updateFigure(req, res) {
  const id = Number(req.params.id);
  if (!(await ownFigureIds(req.user.id, [id])).length) throw new AppError('Figure not found', 404);
  const { caption, description, redescribe } = req.body || {};
  let changes = { caption: text(caption, MAX_CAPTION, 'Caption'), description: text(description, MAX_DESCRIPTION, 'Description') };
  if (redescribe === true) {
    if (!config.ollama.visionModel) throw new AppError('No model is set up to describe figures', 400);
    const figure = await getFigureByIdDb(id);
    const fresh = figure && await describeOne(figure, figure.document_name);
    if (!fresh) throw new AppError('The model couldn’t describe this figure. Try again, or write a description.', 503);
    changes = { description: fresh, byModel: true };
  }
  const figure = await updateFigureDb(id, changes);
  if (!figure) throw new AppError('Figure not found', 404);
  res.json(responseFactory.createJsonResponse({ figure: toPublic(figure) }));
}

export default { listFigures, serveImage, downloadFigures, getUsage, deleteFigures, updateFigure };
