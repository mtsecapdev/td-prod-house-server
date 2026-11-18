import { Router } from 'express';
import figuresController from '../controllers/figuresController.js';

const figuresRouter = Router();

figuresRouter.get('/', figuresController.listFigures);
figuresRouter.get('/:id/image', figuresController.serveImage);
figuresRouter.get('/:id/usage', figuresController.getUsage);
figuresRouter.patch('/:id', figuresController.updateFigure);
figuresRouter.delete('/:id', figuresController.deleteFigure);

export default figuresRouter;
