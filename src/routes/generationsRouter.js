import { Router } from 'express';
import generationsController from '../controllers/generationsController.js';

const generationsRouter = Router();

generationsRouter.post('/', generationsController.createGeneration);
generationsRouter.get('/', generationsController.listGenerations);
generationsRouter.get('/:id', generationsController.getGeneration);
generationsRouter.put('/:id/outline', generationsController.updateOutline);

export default generationsRouter;
