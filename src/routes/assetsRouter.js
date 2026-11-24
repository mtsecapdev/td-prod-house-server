import { Router } from 'express';
import { ownedBy } from '../middleware/auth.js';
import assetsController from '../controllers/assetsController.js';

const assetsRouter = Router();
assetsRouter.param('id', ownedBy('assets', 'Library item'));

assetsRouter.get('/', assetsController.listAssets);
assetsRouter.post('/', assetsController.saveAsset);
assetsRouter.get('/:id/file', assetsController.downloadAsset);
assetsRouter.delete('/:id', assetsController.deleteAsset);

export default assetsRouter;
