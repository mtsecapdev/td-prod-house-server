import { Router } from 'express';
import figuresController from '../controllers/figuresController.js';

const figuresRouter = Router();

figuresRouter.get('/', figuresController.listFigures);
figuresRouter.get('/download', figuresController.downloadFigures);
figuresRouter.get('/:id/image', figuresController.serveImage);
figuresRouter.patch('/:id', figuresController.updateFigure);
// Bulk actions on a selection: body { ids: [...] }
figuresRouter.post('/usage', figuresController.getUsage);
figuresRouter.post('/delete', figuresController.deleteFigures);

export default figuresRouter;
