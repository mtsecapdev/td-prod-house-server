import { Router } from 'express';
import generationsController from '../controllers/generationsController.js';
import { uploadToMemory } from '../middleware/upload.js';
import { ownedBy } from '../middleware/auth.js';

const generationsRouter = Router();
generationsRouter.param('id', ownedBy('generations', 'Deck or document'));

generationsRouter.get('/', generationsController.listGenerations);
generationsRouter.get('/templates', generationsController.getTemplates);
generationsRouter.post('/templates', uploadToMemory.single('file'), generationsController.uploadTemplate);
generationsRouter.delete('/templates/:templateId', generationsController.removeTemplate);
generationsRouter.get('/:id', generationsController.getGeneration);
generationsRouter.put('/:id/outline', generationsController.updateOutline);

// Planning (decks and documents)
generationsRouter.put('/:id/brief', generationsController.updateBrief);
generationsRouter.put('/:id/name', generationsController.renameGeneration);
generationsRouter.post('/:id/outline', generationsController.createOutline);
generationsRouter.post('/:id/outline/:index/sources', generationsController.refreshItemSources);
generationsRouter.get('/:id/sources', generationsController.findSources);

// Writing: writes every item without content, streaming each as it finishes
generationsRouter.post('/:id/write', generationsController.writeSSE);
generationsRouter.post('/:id/slides/:index/regenerate', generationsController.regenerateItem);
generationsRouter.post('/:id/sections/:index/regenerate', generationsController.regenerateItem);
generationsRouter.get('/:id/slides/:index/layouts', generationsController.suggestLayouts);
generationsRouter.get('/:id/sections/:index/layouts', generationsController.suggestLayouts);
generationsRouter.post('/:id/figures', generationsController.addFigure);
generationsRouter.get('/:id/file', generationsController.downloadFile);
generationsRouter.post('/:id/open-deckcraft', generationsController.openInDeckCraft);
generationsRouter.post('/:id/open-wordcraft', generationsController.openInWordCraft);
generationsRouter.post('/:id/diagram', generationsController.renderDiagramCode);
generationsRouter.get('/:id/diagrams/:key', generationsController.serveDiagram);
generationsRouter.delete('/:id', generationsController.deleteGeneration);

export default generationsRouter;
