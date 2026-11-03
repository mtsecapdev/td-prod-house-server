import config from '../config.js';
import { uploadToMemory } from '../middleware/upload.js';
import responseFactory from '../utils/responseFactory.js';
import { extractMarkdownFromBuffer } from '../services/fileProcessor.js';
import { splitMarkdown } from '../services/textChunker.js';
import {
  generateAnswer,
  requestEmbedding,
  rewriteQuery,
} from '../services/llm.js';
import { insertDocumentDb, deleteDocumentDb } from '../db/documentsQueries.js';
import { getSimilarChunksDb, insertChunkDb } from '../db/chunksQueries.js';

const uploadDocumentsPost = [
  uploadToMemory.single('uploaded_file'),
  async (req, res) => {
    const { buffer, originalname } = req.file;
    const markdownText = await extractMarkdownFromBuffer(buffer, originalname);
    const textChunks = await splitMarkdown(markdownText);

    const chunksWithEmbeddings = [];
    for (const text of textChunks) {
      const embedding = await requestEmbedding(text);
      chunksWithEmbeddings.push([text, embedding]);
    }

    const docId = await insertDocumentDb(originalname);
    for (const [text, embedding] of chunksWithEmbeddings) {
      await insertChunkDb(docId, text, embedding);
    }

    console.log(`Inserted ${originalname} (id: ${docId}, ${chunksWithEmbeddings.length} chunks)`);
    res.json(responseFactory.createJsonResponse({
      message: `Uploaded ${originalname} successfully`,
    }));
  },
];

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

async function deleteOneDocument(req, res) {
  const deletedDocument = await deleteDocumentDb(req.params.id);
  res.json(responseFactory.createJsonResponse({ deletedDocument }));
}

export default {
  uploadDocumentsPost,
  queryDocumentsPost,
  deleteOneDocument,
};
