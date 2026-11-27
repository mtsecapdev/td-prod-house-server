import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import config from '../config.js';
import { uploadToMemory } from '../middleware/upload.js';
import responseFactory from '../utils/responseFactory.js';
import AppError from '../utils/AppError.js';
import { getAllDocumentsDb, getDocumentByIdDb, insertDocumentDb, deleteDocumentDb, getDocumentStatusDb } from '../db/documentsQueries.js';
import { deleteFigureFiles } from '../services/figures.js';
import { runImportQueue, watchImport } from '../services/imports.js';
import { figureUsageDb, listFiguresDb } from '../db/figuresQueries.js';
import { openEventStream } from '../utils/eventStream.js';

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function downloadDocument(req, res) {
  const doc = await getDocumentByIdDb(req.params.id);
  if (!doc.file_path) throw new AppError('No file stored for this document', 404);

  try {
    await fs.access(doc.file_path);
  } catch {
    throw new AppError('File not found on disk', 404);
  }

  res.download(doc.file_path, doc.name);
}

// How often an upload's stream checks the document's status, in case its import runs elsewhere (another app
// server) or finished before the stream started listening.
const UPLOAD_STATUS_POLL_MS = 3000;

/**
 * POST a file: it is saved and recorded, and its import runs in the background (services/imports.js). The
 * response streams the import's progress until it is done; closing it does not stop the import.
 */
const uploadDocumentsStream = [
  uploadToMemory.single('uploaded_file'),
  async (req, res) => {
    const { buffer, originalname } = req.file;
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

    await ensureDir(config.uploadsDir);
    const filePath = path.join(config.uploadsDir, `${fileHash}${path.extname(originalname)}`);
    await fs.writeFile(filePath, buffer);
    const docId = await insertDocumentDb(originalname, { ownerId: req.user.id, filePath, fileHash, status: 'processing' });

    const { send, end, isOpen } = openEventStream(res);
    send({ phase: 'uploaded', docId, message: `Waiting to process ${originalname}...` });
    await new Promise((resolve) => {
      const finish = (event) => {
        stopWatching();
        clearInterval(poll);
        if (event) send(event);
        resolve();
      };
      const stopWatching = watchImport(docId, (event) => {
        if (event.phase === 'done' || event.phase === 'error') finish(event);
        else send(event);
      });
      const poll = setInterval(async () => {
        if (!isOpen()) return finish(null);
        const status = await getDocumentStatusDb(docId).catch(() => null);
        if (!status) finish({ phase: 'error', message: 'Document was deleted' });
        else if (status.status === 'ready') finish({ phase: 'done', docId, message: `${originalname} is ready` });
        else if (status.status === 'failed') finish({ phase: 'error', message: status.error || 'Import failed' });
      }, UPLOAD_STATUS_POLL_MS);
      runImportQueue();
    });
    end();
  },
];

async function listDocuments(req, res) {
  const docs = await getAllDocumentsDb(req.user.id);
  res.json(responseFactory.createJsonResponse({ docs }));
}

// Where this document's figures are used in decks and documents (checked before deleting it).
async function figureUsageOfDocument(documentId) {
  const figures = await listFiguresDb({ documentIds: [Number(documentId)] });
  return figureUsageDb(figures.map((f) => f.id));
}

async function documentUsage(req, res) {
  res.json(responseFactory.createJsonResponse({ usage: await figureUsageOfDocument(req.params.id) }));
}

// A document whose figures are used elsewhere needs ?force=1 to delete; those slides then show "Figure removed".
async function deleteOneDocument(req, res) {
  const usage = await figureUsageOfDocument(req.params.id);
  if (usage.length && req.query.force !== '1') {
    return res.status(409).json(responseFactory.createJsonResponse({ usage }, {
      message: `Figures from this document are used in ${usage.length} place${usage.length === 1 ? '' : 's'}`,
    }));
  }
  const deletedDocument = await deleteDocumentDb(req.params.id); // figure rows go with it (ON DELETE CASCADE)
  await deleteFigureFiles(req.params.id);
  res.json(responseFactory.createJsonResponse({ deletedDocument }));
}

export default {
  listDocuments,
  uploadDocumentsStream,
  downloadDocument,
  documentUsage,
  deleteOneDocument,
};
