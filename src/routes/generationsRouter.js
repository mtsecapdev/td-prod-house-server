import { Router } from 'express';
import generationsController from '../controllers/generationsController.js';

const generationsRouter = Router();

generationsRouter.post('/', generationsController.createGeneration);
generationsRouter.get('/', generationsController.listGenerations);
generationsRouter.get('/:id', generationsController.getGeneration);
generationsRouter.put('/:id/outline', generationsController.updateOutline);
generationsRouter.post('/:id/generate', generationsController.generateSlides);
generationsRouter.post('/:id/slides/:slideIndex/chat', generationsController.editSlideChat);

export default generationsRouter;
