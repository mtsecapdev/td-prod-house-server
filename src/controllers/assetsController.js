import responseFactory from '../utils/responseFactory.js';
import { getAllAssetsDb, softDeleteAssetDb } from '../db/assetsQueries.js';

async function listAssets(req, res) {
  const { q, kind } = req.query;
  const assets = await getAllAssetsDb({ q, kind });
  res.json(responseFactory.createJsonResponse({ assets }));
}

async function deleteAsset(req, res) {
  const asset = await softDeleteAssetDb(req.params.id);
  res.json(responseFactory.createJsonResponse({ asset }));
}

export default { listAssets, deleteAsset };
