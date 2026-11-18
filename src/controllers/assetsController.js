import { access } from 'node:fs/promises';
import responseFactory from '../utils/responseFactory.js';
import { getGenerationByIdDb, generationName } from '../db/generationsQueries.js';
import { insertAssetDb, getAssetByIdDb, getAllAssetsDb, softDeleteAssetDb } from '../db/assetsQueries.js';
import { renderOfficeFile, notReadyMessage, officeExt, OFFICE_MIME } from '../services/officeRenderer.js';

async function listAssets(req, res) {
  const { q, kind } = req.query;
  const assets = await getAllAssetsDb({ q, kind });
  res.json(responseFactory.createJsonResponse({ assets }));
}

async function saveAsset(req, res) {
  const { generationId, title } = req.body;
  if (!generationId) {
    return res.status(400).json(responseFactory.createJsonResponse(null, { message: 'generationId is required' }));
  }

  const generation = await getGenerationByIdDb(generationId);

  if (generation.type === 'image') {
    const filePath = generation.outline?.file_path;
    if (!filePath) {
      return res.status(400).json(responseFactory.createJsonResponse(null, { message: 'No file generated yet' }));
    }
    const assetTitle = title || generation.brief?.topic || 'Untitled image';
    const assetId = await insertAssetDb({
      generationId: generation.id, kind: 'image', filePath, mime: 'image/png', title: assetTitle,
    });
    return res.status(201).json(responseFactory.createJsonResponse({ id: assetId, title: assetTitle }));
  }

  const notReady = notReadyMessage(generation);
  if (notReady) return res.status(400).json(responseFactory.createJsonResponse(null, { message: notReady }));

  // 'keep': each Library save gets its own file, so later downloads or saves never change it.
  let outputPath;
  try {
    outputPath = await renderOfficeFile(generation, 'keep');
  } catch (err) {
    return res.status(500).json(responseFactory.createJsonResponse(null, { message: err.message }));
  }

  const ext = officeExt(generation);
  const kind = generation.type;
  const assetTitle = title || generationName(generation);
  const assetId = await insertAssetDb({
    generationId: generation.id,
    kind,
    filePath: outputPath,
    mime: OFFICE_MIME[ext],
    title: assetTitle,
  });

  res.status(201).json(responseFactory.createJsonResponse({ id: assetId, title: assetTitle }));
}

async function downloadAsset(req, res) {
  const asset = await getAssetByIdDb(req.params.id);

  try {
    await access(asset.file_path);
  } catch {
    return res.status(404).json(responseFactory.createJsonResponse(null, { message: 'File not found on disk' }));
  }

  const filename = (asset.title || 'download').replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 60).trim();
  const ext = asset.mime?.includes('presentation') ? '.pptx'
    : asset.mime?.includes('wordprocessingml') ? '.docx'
    : asset.mime === 'image/png' ? '.png'
    : '';
  res.download(asset.file_path, `${filename}${ext}`);
}

async function deleteAsset(req, res) {
  const asset = await softDeleteAssetDb(req.params.id);
  res.json(responseFactory.createJsonResponse({ asset }));
}

export default { listAssets, saveAsset, downloadAsset, deleteAsset };
