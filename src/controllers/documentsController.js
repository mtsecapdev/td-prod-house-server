import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import config from '../config.js';
import { uploadToMemory } from '../middleware/upload.js';
import responseFactory from '../utils/responseFactory.js';
import AppError from '../utils/AppError.js';
import { extractMarkdownFromFile } from '../services/fileProcessor.js';
import { splitMarkdown, enrichTextForEmbedding } from '../services/textChunker.js';
import { requestEmbeddingBatch } from '../services/llm.js';
import { getAllDocumentsDb, getDocumentByIdDb, insertDocumentDb, updateDocumentStatusDb, deleteDocumentDb, documentExistsDb } from '../db/documentsQueries.js';
import { insertChunkDb } from '../db/chunksQueries.js';
import { generateSummaryChunks } from '../services/summarizer.js';
import { saveFigures, deleteFigureFiles } from '../services/figures.js';
import { figureUsageDb, listFiguresDb } from '../db/figuresQueries.js';

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

const uploadDocumentsStream = [
  uploadToMemory.single('uploaded_file'),
  async (req, res) => {
    const { buffer, originalname } = req.file;
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

    await ensureDir(config.uploadsDir);
    const ext = path.extname(originalname);
    const savedName = `${fileHash}${ext}`;
    const filePath = path.join(config.uploadsDir, savedName);
    await fs.writeFile(filePath, buffer);

    const docId = await insertDocumentDb(originalname, { ownerId: req.user.id, filePath, fileHash, status: 'processing' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const send = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send({ phase: 'uploaded', docId, message: `Processing ${originalname}...` });

    const aborted = async () => !(await documentExistsDb(docId));

    try {
      const { markdown, pageCount, pageStarts, figures } = await extractMarkdownFromFile(filePath, originalname, (progress) => {
        send(progress);
      });

      if (await aborted()) { send({ phase: 'error', message: 'Document was deleted' }); res.end(); return; }

      if (figures.length) send({ phase: 'chunking', message: `Saving ${figures.length} figures...` });
      await saveFigures(docId, figures);

      send({ phase: 'chunking', message: 'Splitting into text chunks...' });
      const chunks = await splitMarkdown(markdown, pageStarts);

      if (await aborted()) { send({ phase: 'error', message: 'Document was deleted' }); res.end(); return; }

      send({ phase: 'embedding', message: `Embedding ${chunks.length} chunks...`, total: chunks.length });
      const embeddings = await requestEmbeddingBatch(chunks.map((c) => enrichTextForEmbedding(c.text, c)));

      if (await aborted()) { send({ phase: 'error', message: 'Document was deleted' }); res.end(); return; }

      send({ phase: 'storing', message: 'Saving to database...' });
      for (let i = 0; i < chunks.length; i++) {
        await insertChunkDb(docId, chunks[i].text, embeddings[i], { page: chunks[i].page, heading: chunks[i].heading });
      }

      if (await aborted()) { send({ phase: 'error', message: 'Document was deleted' }); res.end(); return; }

      send({ phase: 'summarizing', message: 'Generating summaries...' });
      await generateSummaryChunks(docId, chunks, {
        onProgress: ({ step, current, total }) => {
          if (step === 'section') send({ phase: 'summarizing', message: `Summarizing section ${current} of ${total}...`, current, total });
          else if (step === 'document') send({ phase: 'summarizing', message: 'Generating document overview...' });
        },
      });

      await updateDocumentStatusDb(docId, 'ready');
      send({ phase: 'done', docId, message: `${originalname} is ready`, chunks: chunks.length });
      console.log(`Ingested upload: ${originalname} (id: ${docId}, ${chunks.length} chunks)`);
    } catch (err) {
      if (await documentExistsDb(docId)) {
        await updateDocumentStatusDb(docId, 'failed', err.message);
      }
      send({ phase: 'error', message: err.message });
      console.error(`Upload ingestion failed: ${originalname} — ${err.message}`);
    }
    res.end();
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
