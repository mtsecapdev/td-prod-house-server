import { Router } from 'express';
import generationsController from '../controllers/generationsController.js';
import { uploadToMemory } from '../middleware/upload.js';

const generationsRouter = Router();

generationsRouter.post('/', generationsController.createGeneration);
generationsRouter.get('/', generationsController.listGenerations);
generationsRouter.get('/:id', generationsController.getGeneration);
generationsRouter.put('/:id/outline', generationsController.updateOutline);
generationsRouter.post('/:id/generate', generationsController.generateSlides);
generationsRouter.post('/:id/generate-sections', generationsController.generateSections);
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
generationsRouter.post('/:id/generate-infographic', generationsController.generateInfographicSSE);
generationsRouter.post('/:id/infographic/chat', generationsController.editInfographicChat);
generationsRouter.get('/:id/infographic', generationsController.serveInfographic);
generationsRouter.post('/release-gpu', generationsController.releaseGpu);
generationsRouter.delete('/:id', generationsController.deleteGeneration);

export default generationsRouter;
