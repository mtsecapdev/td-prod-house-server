import { Router } from 'express';
import documentsController from '../controllers/documentsController.js';

const documentsRouter = Router();

documentsRouter.get('/', documentsController.listDocuments);
documentsRouter.post(
  '/upload',
  documentsController.uploadDocumentsPost,
);
documentsRouter.post(
  '/upload-stream',
  documentsController.uploadDocumentsStream,
);
documentsRouter.post('/query', documentsController.queryDocumentsPost);
documentsRouter.get('/:id/file', documentsController.downloadDocument);
documentsRouter.delete('/:id', documentsController.deleteOneDocument);

export default documentsRouter;
