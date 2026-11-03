import responseFactory from '../utils/responseFactory.js';
import {
  insertGenerationDb,
  getGenerationByIdDb,
  updateGenerationDb,
  getAllGenerationsDb,
} from '../db/generationsQueries.js';
import { generateOutline, generateAllSlides } from '../services/deckGenerator.js';
import { editSlide } from '../services/editChat.js';

async function createGeneration(req, res) {
  const { type, brief, sourceDocumentIds, model, settings } = req.body;
  const id = await insertGenerationDb({ type, brief, sourceDocumentIds, model, settings });

  const generation = await getGenerationByIdDb(id);

  if (type === 'deck') {
    await updateGenerationDb(id, { status: 'generating' });
    const outline = await generateOutline(generation);
    await updateGenerationDb(id, { outline: JSON.stringify(outline), status: 'outline_ready' });
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

    send({ phase: 'start', total: generation.outline.slides.length });

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

async function editSlideChat(req, res) {
  const { instruction, history } = req.body;
  const slideIndex = Number(req.params.slideIndex);
  const updatedContent = await editSlide(req.params.id, slideIndex, instruction, history);
  res.json(responseFactory.createJsonResponse({ slide: updatedContent }));
}

export default {
  createGeneration,
  getGeneration,
  listGenerations,
  updateOutline,
  generateSlides,
  editSlideChat,
};
