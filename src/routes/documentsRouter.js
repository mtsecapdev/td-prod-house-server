import { Router } from 'express';
import documentsController from '../controllers/documentsController.js';

const documentsRouter = Router();

documentsRouter.get('/', documentsController.listDocuments);
documentsRouter.post(
  '/upload-stream',
  documentsController.uploadDocumentsStream,
);
documentsRouter.get('/:id/file', documentsController.downloadDocument);
documentsRouter.get('/:id/usage', documentsController.documentUsage);
documentsRouter.delete('/:id', documentsController.deleteOneDocument);

export default documentsRouter;
