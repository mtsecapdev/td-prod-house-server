// Utils
import { uploadToMemory } from '../middleware/upload.js';
import responseFactory from '../utils/responseFactory.js';

// Services
import { extractMarkdownFromBuffer } from '../services/fileProcessor.js';
import { splitMarkdown } from '../services/textChunker.js';
import {
  generateAnswer,
  requestEmbedding,
  rewriteQuery,
} from '../services/llm.js';

// DB Queries
import { insertDocumentDb, deleteDocumentDb } from '../db/documentsQueries.js';
import { getSimilarChunksDb, insertChunkDb } from '../db/chunksQueries.js';

// After multer processing:
// req.file.originalname → 'rsn_wiki.pdf'
// req.file.mimetype → 'application/pdf'
// req.file.buffer → the raw file bytes, ~16.9MB — this is what pdf-parse will consume in step 2

/**
 * Array of middleware for the POST /documents/upload endpoints.
 * First mw is to call multer's uploadToMemory to parse the pdf file.
 * Second mw is the handler to upload the PDF and its chunks into the DB.
 */
const uploadDocumentsPostMiddlewareArray = [
  uploadToMemory.single('uploaded_file'),
  /**
   * Parses the PDF, get the embeddings of each chunk, upload to DB.
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async (req, res, next) => {
    console.log('--- PDF Uploaded. Commence parsing ---');
    // TODO: Need validate file type is pdf else throw error. Ref: upload.js
    // TODO: How to provide some form of loading percentage UI?

    // Assume can parse out text:
    const buffer = req.file.buffer;
    const filename = req.file.originalname;
    const markdownText = await extractMarkdownFromBuffer(buffer, filename);
    const textChunks = await splitMarkdown(markdownText);

    // Build up the arr of [textChunk, embedding]
    const chunksDbEntries = [];
    for (const text of textChunks) {
      const embedding = await requestEmbedding(text);
      chunksDbEntries.push([text, embedding]);
    }

    // // Once all the textChunks have been embedded and their text stored,
    // // Upload the document name to DB so we can get the document_id for chunks fk reference.
    const docId = await insertDocumentDb(req.file.originalname);

    // Then upload each chunkDbEntry to chunks DB.
    for (const chunksDbEntry of chunksDbEntries) {
      await insertChunkDb(docId, chunksDbEntry[0], chunksDbEntry[1]);
    }

    console.log(
      `Name: ${filename} inserted with id: ${docId}. Chunks inserted ${chunksDbEntries.length}`,
    );

    res.json(
      responseFactory.createJsonResponse({
        message: `Uploaded ${filename} successfully`,
      }),
    );
  },
];

const numberOfChunks = process.env.K_CHUNKS;

/**
 * To handle the RAG query
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function queryDocumentsPost(req, res, next) {
  const { query: originalQuery, history, docIdsToReference } = req.body;

  const rewrittenQuery = await rewriteQuery(history, originalQuery);
  const queryEmbedding = await requestEmbedding(rewrittenQuery);
  // Find the top k semantically similar chunks in the db - use pgvector library to help
  const kMostSimilarChunks = await getSimilarChunksDb(
    queryEmbedding,
    numberOfChunks,
    docIdsToReference,
  );

  console.log(
    `--- Generating answer for originalQuery: ${originalQuery}; rewritten as: ${rewrittenQuery} ---`,
  );

  // Response shape is [{role: 'user', content: query}, {role:'assistant', content: generated response}]
  const { llmResponse, avgConfidenceScore } = await generateAnswer(
    rewrittenQuery,
    history,
    kMostSimilarChunks,
  );

  // Build array which maps the docId to its corresponding array of chunks,
  // So we can display that for this docId, what chunks were found.
  const chunks = {};
  docIdsToReference.forEach((docId) => {
    const chunksForThisDocId = kMostSimilarChunks.filter(
      (chunk) => chunk.document_id === docId,
    );
    chunks[docId] = chunksForThisDocId;
  });

  res.json(
    responseFactory.createJsonResponse({
      originalQuery,
      modelResponse: llmResponse,
      history: [
        ...history,
        { role: 'user', content: originalQuery },
        llmResponse,
      ],
      chunks,
      numberOfChunks,
      avgConfidenceScore,
    }),
  );
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function deleteOneDocument(req, res, next) {
  // Retrieve the paramter from the req
  const { id } = req.params;
  // Call db delete query with the id
  const deletedDocument = await deleteDocumentDb(id);
  // Return the res with the deleted item.
  res.json(
    responseFactory.createJsonResponse({
      message: {
        deletedDocument,
      },
    }),
  );
}

export default {
  uploadDocumentsPostMiddlewareArray,
  queryDocumentsPost,
  deleteOneDocument,
};
