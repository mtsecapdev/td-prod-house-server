import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import config from '../config.js';
import { uploadToMemory } from '../middleware/upload.js';
import responseFactory from '../utils/responseFactory.js';
import AppError from '../utils/AppError.js';
import { extractMarkdownFromBuffer } from '../services/fileProcessor.js';
import { splitMarkdown } from '../services/textChunker.js';
import {
  generateAnswer,
  requestEmbedding,
  rewriteQuery,
} from '../services/llm.js';
import { getAllDocumentsDb, getDocumentByIdDb, insertDocumentDb, updateDocumentStatusDb, deleteDocumentDb } from '../db/documentsQueries.js';
import { getSimilarChunksDb, insertChunkDb } from '../db/chunksQueries.js';

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

const uploadDocumentsPost = [
  uploadToMemory.single('uploaded_file'),
  async (req, res) => {
    const { buffer, originalname } = req.file;
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

    await ensureDir(config.uploadsDir);
    const ext = path.extname(originalname);
    const savedName = `${fileHash}${ext}`;
    const filePath = path.join(config.uploadsDir, savedName);
    await fs.writeFile(filePath, buffer);

    const docId = await insertDocumentDb(originalname, { filePath, fileHash, status: 'processing' });

    res.json(responseFactory.createJsonResponse({
      message: `Upload received — processing ${originalname}`,
      document: { id: docId, name: originalname, status: 'processing' },
    }));

    try {
      const markdownText = await extractMarkdownFromBuffer(buffer, originalname);
      const textChunks = await splitMarkdown(markdownText);

      for (const text of textChunks) {
        const embedding = await requestEmbedding(text);
        await insertChunkDb(docId, text, embedding);
      }

      await updateDocumentStatusDb(docId, 'ready');
      console.log(`Ingested upload: ${originalname} (id: ${docId}, ${textChunks.length} chunks)`);
    } catch (err) {
      await updateDocumentStatusDb(docId, 'failed', err.message);
      console.error(`Upload ingestion failed: ${originalname} — ${err.message}`);
    }
  },
];

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

async function queryDocumentsPost(req, res) {
  const { query: originalQuery, history, docIdsToReference } = req.body;

  const rewrittenQuery = await rewriteQuery(history, originalQuery);
  const queryEmbedding = await requestEmbedding(rewrittenQuery);
  const topChunks = await getSimilarChunksDb(
    queryEmbedding,
    config.rag.topK,
    docIdsToReference,
  );

  const { llmResponse, avgConfidenceScore } = await generateAnswer(
    rewrittenQuery,
    history,
    topChunks,
  );

  const chunksByDoc = {};
  for (const docId of docIdsToReference) {
    chunksByDoc[docId] = topChunks.filter((c) => c.document_id === docId);
  }

  res.json(responseFactory.createJsonResponse({
    originalQuery,
    modelResponse: llmResponse,
    history: [
      ...history,
      { role: 'user', content: originalQuery },
      llmResponse,
    ],
    chunks: chunksByDoc,
    avgConfidenceScore,
  }));
}

async function listDocuments(req, res) {
  const docs = await getAllDocumentsDb();
  res.json(responseFactory.createJsonResponse({ docs }));
}

async function deleteOneDocument(req, res) {
  const deletedDocument = await deleteDocumentDb(req.params.id);
  res.json(responseFactory.createJsonResponse({ deletedDocument }));
}

export default {
  listDocuments,
  uploadDocumentsPost,
  downloadDocument,
  queryDocumentsPost,
  deleteOneDocument,
};
