// Figures from ingested documents as assets: list/search, image, where they are used, hide, delete.
import { unlink } from 'node:fs/promises';
import responseFactory from '../utils/responseFactory.js';
import AppError from '../utils/AppError.js';
import {
  listFiguresDb, getFigureByIdDb, setFigureHiddenDb, deleteFigureDb, figureUsageDb,
} from '../db/figuresQueries.js';

function toPublic(f) {
  const { file_path: _p, key: _k, ...rest } = f;
  return rest;
}

async function listFigures(req, res) {
  const documentIds = String(req.query.documentIds || '').split(',').map(Number).filter(Number.isInteger).filter(Boolean);
  const figures = await listFiguresDb({
    q: req.query.q,
    documentIds,
    includeHidden: req.query.includeHidden === '1',
  });
  res.json(responseFactory.createJsonResponse({ figures: figures.map(toPublic) }));
}

async function serveImage(req, res) {
  const figure = await getFigureByIdDb(Number(req.params.id));
  if (!figure) throw new AppError('Figure not found', 404);
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(figure.file_path);
}

async function getUsage(req, res) {
  res.json(responseFactory.createJsonResponse({ usage: await figureUsageDb([Number(req.params.id)]) }));
}

async function updateFigure(req, res) {
  const id = Number(req.params.id);
  if (!(await getFigureByIdDb(id))) throw new AppError('Figure not found', 404);
  if (typeof req.body?.hidden === 'boolean') await setFigureHiddenDb(id, req.body.hidden);
  res.json(responseFactory.createJsonResponse({ figure: toPublic(await getFigureByIdDb(id)) }));
}

// Deleting a figure that decks or documents use needs ?force=1; without it the response lists where it is used
// so the client can warn first. Slides that used it then show "Figure removed".
async function deleteFigure(req, res) {
  const id = Number(req.params.id);
  const usage = await figureUsageDb([id]);
  if (usage.length && req.query.force !== '1') {
    return res.status(409).json(responseFactory.createJsonResponse({ usage }, {
      message: `This figure is used in ${usage.length} place${usage.length === 1 ? '' : 's'}`,
    }));
  }
  const row = await deleteFigureDb(id);
  if (!row) throw new AppError('Figure not found', 404);
  await unlink(row.file_path).catch(() => {});
  res.json(responseFactory.createJsonResponse({ deleted: true, removedFrom: usage.length }));
}

export default { listFigures, serveImage, getUsage, updateFigure, deleteFigure };
