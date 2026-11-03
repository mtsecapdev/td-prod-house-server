import responseFactory from '../utils/responseFactory.js';
import {
  insertGenerationDb,
  getGenerationByIdDb,
  updateGenerationDb,
  getAllGenerationsDb,
} from '../db/generationsQueries.js';

async function createGeneration(req, res) {
  const { type, brief, sourceDocumentIds, model, settings } = req.body;
  const id = await insertGenerationDb({ type, brief, sourceDocumentIds, model, settings });
  const generation = await getGenerationByIdDb(id);
  res.status(201).json(responseFactory.createJsonResponse({ generation }));
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
  await updateGenerationDb(req.params.id, { outline });
  const generation = await getGenerationByIdDb(req.params.id);
  res.json(responseFactory.createJsonResponse({ generation }));
}

export default { createGeneration, getGeneration, listGenerations, updateOutline };
