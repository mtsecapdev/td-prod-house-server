import { execFile } from 'node:child_process';
import { writeFile, unlink, mkdir, access } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import responseFactory from '../utils/responseFactory.js';
import config from '../config.js';
import { getGenerationByIdDb } from '../db/generationsQueries.js';
import { insertAssetDb, getAssetByIdDb, getAllAssetsDb, softDeleteAssetDb } from '../db/assetsQueries.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

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

  if (generation.type === 'image' || generation.type === 'infographic') {
    const filePath = generation.outline?.file_path;
    if (!filePath) {
      return res.status(400).json(responseFactory.createJsonResponse(null, { message: 'No file generated yet' }));
    }
    const kind = generation.type;
    const mime = 'image/png';
    const assetTitle = title || generation.brief?.topic || `Untitled ${kind}`;
    const assetId = await insertAssetDb({
      generationId: generation.id, kind, filePath, mime, title: assetTitle,
    });
    return res.status(201).json(responseFactory.createJsonResponse({ id: assetId, title: assetTitle }));
  }

  const isDeck = generation.type === 'deck';
  const isDoc = generation.type === 'doc';

  if (isDeck && !generation.outline?.slides?.length) {
    return res.status(400).json(responseFactory.createJsonResponse(null, { message: 'No slides generated yet' }));
  }
  if (isDoc && !generation.outline?.sections?.length) {
    return res.status(400).json(responseFactory.createJsonResponse(null, { message: 'No sections generated yet' }));
  }

  const ext = isDeck ? 'pptx' : 'docx';
  const outDir = join(config.outputDir, ext);
  await mkdir(outDir, { recursive: true });

  const inputPath = join(outDir, `${generation.id}_input.json`);
  const outputPath = join(outDir, `${generation.id}.${ext}`);
  const scriptName = isDeck ? 'render_pptx.py' : 'render_docx.py';
  const scriptPath = join(__dirname, '..', '..', 'scripts', scriptName);

  await writeFile(inputPath, JSON.stringify(generation.outline), 'utf-8');

  try {
    await execFileAsync('python', [scriptPath, inputPath, outputPath], { timeout: 30_000 });
  } catch (err) {
    await unlink(inputPath).catch(() => {});
    return res.status(500).json(responseFactory.createJsonResponse(null, {
      message: `${ext.toUpperCase()} rendering failed: ${err.stderr || err.message}`,
    }));
  }

  await unlink(inputPath).catch(() => {});

  const kind = isDeck ? 'deck' : 'doc';
  const mime = isDeck
    ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const assetTitle = title || generation.brief?.topic || `Untitled ${kind}`;
  const assetId = await insertAssetDb({
    generationId: generation.id,
    kind,
    filePath: outputPath,
    mime,
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
