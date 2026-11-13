import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import config from '../config.js';
import { uploadToMemory } from '../middleware/upload.js';
import responseFactory from '../utils/responseFactory.js';
import AppError from '../utils/AppError.js';
import { extractMarkdownFromFile } from '../services/fileProcessor.js';
import { splitMarkdown, enrichTextForEmbedding } from '../services/textChunker.js';
import {
  generateAnswer,
  requestEmbedding,
  requestEmbeddingBatch,
  rewriteQuery,
} from '../services/llm.js';
import { getAllDocumentsDb, getDocumentByIdDb, insertDocumentDb, updateDocumentStatusDb, deleteDocumentDb, documentExistsDb } from '../db/documentsQueries.js';
import { getSimilarChunksDb, getNeighborChunksDb, insertChunkDb } from '../db/chunksQueries.js';
import { generateSummaryChunks } from '../services/summarizer.js';

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
      const { markdown, pageCount, pageMarkers } = await extractMarkdownFromFile(filePath, originalname);
      const chunks = await splitMarkdown(markdown, pageMarkers);
      const embeddings = await requestEmbeddingBatch(chunks.map((c) => enrichTextForEmbedding(c.text, c)));

      for (let i = 0; i < chunks.length; i++) {
        await insertChunkDb(docId, chunks[i].text, embeddings[i], { page: chunks[i].page, heading: chunks[i].heading });
      }

      console.log(`Generating summaries for: ${originalname}`);
      await generateSummaryChunks(docId, chunks);

      await updateDocumentStatusDb(docId, 'ready');
      console.log(`Ingested upload: ${originalname} (id: ${docId}, ${chunks.length} chunks)`);
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

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  const send = (data) => { res.write(`data: ${JSON.stringify(data)}\n\n`); };

  let keepalive;
  try {
    send({ phase: 'loading', message: 'Preparing model...' });
    keepalive = setInterval(() => res.write(': keepalive\n\n'), 5000);

    send({ phase: 'rewriting' });
    const rewrittenQuery = await rewriteQuery(history, originalQuery);

    send({ phase: 'searching' });
    const queryEmbedding = await requestEmbedding(rewrittenQuery);
    const topChunks = await getSimilarChunksDb(
      queryEmbedding,
      config.rag.topK,
      docIdsToReference,
      rewrittenQuery,
    );

    const seenIds = new Set(topChunks.map((c) => c.id));
    const expanded = [...topChunks];
    const EXPAND_THRESHOLD = 0.6;
    for (const chunk of topChunks) {
      if (chunk.level !== 'leaf' || chunk.similarity < EXPAND_THRESHOLD) continue;
      const neighbors = await getNeighborChunksDb(chunk.id, chunk.document_id, 3);
      for (const n of neighbors) {
        if (!seenIds.has(n.id)) {
          seenIds.add(n.id);
          n.similarity = chunk.similarity * 0.9;
          expanded.push(n);
        }
      }
    }
    expanded.sort((a, b) => b.similarity - a.similarity);
    const finalChunks = expanded.slice(0, config.rag.topK + 5);

    send({ phase: 'generating' });
    const { llmResponse, avgConfidenceScore } = await generateAnswer(
      rewrittenQuery,
      history,
      finalChunks,
    );

    const chunksByDoc = {};
    for (const docId of docIdsToReference) {
      chunksByDoc[docId] = finalChunks.filter((c) => c.document_id === docId);
    }

    send({
      phase: 'done',
      originalQuery,
      modelResponse: llmResponse,
      history: [
        ...history,
        { role: 'user', content: originalQuery },
        llmResponse,
      ],
      chunks: chunksByDoc,
      avgConfidenceScore,
    });
  } catch (err) {
    send({ phase: 'error', message: err.message });
  } finally {
    clearInterval(keepalive);
  }
  res.end();
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

    const docId = await insertDocumentDb(originalname, { filePath, fileHash, status: 'processing' });

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
      const { markdown, pageCount, pageMarkers } = await extractMarkdownFromFile(filePath, originalname, (progress) => {
        send(progress);
      });

      if (await aborted()) { send({ phase: 'error', message: 'Document was deleted' }); res.end(); return; }

      send({ phase: 'chunking', message: 'Splitting into text chunks...' });
      const chunks = await splitMarkdown(markdown, pageMarkers);

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
  uploadDocumentsStream,
  downloadDocument,
  queryDocumentsPost,
  deleteOneDocument,
};
