import { Router } from 'express';
import documentsController from '../controllers/documentsController.js';

const documentsRouter = Router();

documentsRouter.post(
  '/upload',
  documentsController.uploadDocumentsPost,
);
documentsRouter.post('/query', documentsController.queryDocumentsPost);
documentsRouter.delete('/:id', documentsController.deleteOneDocument);

export default documentsRouter;
