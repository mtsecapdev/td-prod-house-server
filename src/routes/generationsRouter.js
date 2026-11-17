import { Router } from 'express';
import generationsController from '../controllers/generationsController.js';
import { uploadToMemory } from '../middleware/upload.js';

const generationsRouter = Router();

generationsRouter.post('/', generationsController.createGeneration);
generationsRouter.get('/', generationsController.listGenerations);
generationsRouter.get('/templates', generationsController.getTemplates);
generationsRouter.get('/:id', generationsController.getGeneration);
generationsRouter.put('/:id/outline', generationsController.updateOutline);

// Planning (decks and documents)
generationsRouter.put('/:id/brief', generationsController.updateBrief);
generationsRouter.post('/:id/outline', generationsController.createOutline);
generationsRouter.post('/:id/outline/:index/sources', generationsController.refreshItemSources);
generationsRouter.get('/:id/sources', generationsController.findSources);

// Writing: writes every item without content, streaming each as it finishes
generationsRouter.post('/:id/write', generationsController.writeSSE);
generationsRouter.post('/:id/slides/:index/regenerate', generationsController.regenerateItem);
generationsRouter.post('/:id/sections/:index/regenerate', generationsController.regenerateItem);
generationsRouter.post('/:id/slides', generationsController.addItem);
generationsRouter.post('/:id/sections', generationsController.addItem);
generationsRouter.post('/:id/slides/:slideIndex/chat', generationsController.editSlideChat);
generationsRouter.post('/:id/sections/:sectionIndex/chat', generationsController.editSectionChat);
generationsRouter.get('/:id/file', generationsController.downloadFile);
generationsRouter.post('/:id/open-deckcraft', generationsController.openInDeckCraft);
generationsRouter.post('/:id/open-wordcraft', generationsController.openInWordCraft);
generationsRouter.post('/:id/reference-image', uploadToMemory.single('image'), generationsController.uploadReferenceImage);
generationsRouter.post('/:id/craft-prompt', generationsController.craftPrompt);
generationsRouter.put('/:id/prompt', generationsController.updatePrompt);
generationsRouter.post('/:id/generate-image', generationsController.generateImageSSE);
generationsRouter.get('/:id/image', generationsController.serveImage);
generationsRouter.post('/:id/diagram', generationsController.renderDiagramCode);
generationsRouter.get('/:id/diagrams/:key', generationsController.serveDiagram);
generationsRouter.post('/release-gpu', generationsController.releaseGpu);
generationsRouter.delete('/:id', generationsController.deleteGeneration);

export default generationsRouter;
