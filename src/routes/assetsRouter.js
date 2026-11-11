import { Router } from 'express';
import assetsController from '../controllers/assetsController.js';

const assetsRouter = Router();

assetsRouter.get('/', assetsController.listAssets);
assetsRouter.post('/', assetsController.saveAsset);
assetsRouter.get('/:id/file', assetsController.downloadAsset);
assetsRouter.delete('/:id', assetsController.deleteAsset);

export default assetsRouter;
