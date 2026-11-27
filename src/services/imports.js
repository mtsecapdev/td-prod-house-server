// Importing documents, as background jobs. An upload only saves the file and records the document; the import
// (convert, figures, passages, embeddings, figure descriptions, overview) runs here, one document at a time,
// outside the request: a closed tab, or another user generating a deck, doesn't stop it, and a server restart
// doesn't leave it stuck at "processing" (an import whose heartbeat stopped is started again, from a clean
// slate). The claim and the heartbeat live in Postgres, so several app servers can share the queue.
import { EventEmitter } from 'node:events';
import { extractMarkdownFromFile } from './fileProcessor.js';
import { saveFigures, deleteFigureFiles } from './figures.js';
import { splitMarkdown, enrichTextForEmbedding } from './textChunker.js';
import { requestEmbeddingBatch } from './llm.js';
import { writeOverview } from './summarizer.js';
import { describeDocumentFigures } from './figureDescriptions.js';
import { unload as unloadModel } from './providers/ollama.js';
import config from '../config.js';
import { insertChunkDb } from '../db/chunksQueries.js';
import {
  claimNextImportDb, heartbeatImportDb, clearImportedDb, updateDocumentStatusDb, documentExistsDb,
} from '../db/documentsQueries.js';

const HEARTBEAT_MS = 10_000;
// An import whose heartbeat is older than this was cut off (a restart): it is started again.
const STALE_SECONDS = 60;
// How often the queue is checked for imports left waiting or cut off.
const SWEEP_MS = 30_000;

const progress = new EventEmitter();
progress.setMaxListeners(0);

class Deleted extends Error {}

/**
 * Imports one document: everything it stores is built from its file. `report(event)` gets progress events
 * ({ phase, message, current?, total? }). Stops if the document is deleted meanwhile.
 */
export async function importDocument(doc, report = () => {}) {
  const still = async () => { if (!(await documentExistsDb(doc.id))) throw new Deleted(); };
  // A restarted import starts from scratch.
  await clearImportedDb(doc.id);
  await deleteFigureFiles(doc.id);
  // The converter (docling) needs GPU memory too; the vision model, still loaded beside the text model from
  // describing the previous document's figures, would leave it almost none. It loads again for this one's.
  if (config.ollama.visionModel) await unloadModel(config.ollama.visionModel).catch(() => {});

  const { markdown, pageStarts, figures } = await extractMarkdownFromFile(doc.file_path, doc.name, report);
  await still();
  if (figures.length) report({ phase: 'chunking', message: `Saving ${figures.length} figures...` });
  await saveFigures(doc.id, figures);

  report({ phase: 'chunking', message: 'Splitting into sections...' });
  const passages = splitMarkdown(markdown, pageStarts);
  report({ phase: 'embedding', message: `Indexing ${passages.length} passages...`, total: passages.length });
  const embeddings = await requestEmbeddingBatch(passages.map((p) => enrichTextForEmbedding(p.text, p)));
  await still();

  report({ phase: 'storing', message: 'Saving to database...' });
  for (let i = 0; i < passages.length; i++) {
    const p = passages[i];
    await insertChunkDb(doc.id, p.text, embeddings[i], { page: p.page, heading: p.heading, section: p.section });
  }
  await still();

  // The document is ready only once its figures are described: picking figures for slides goes by what they show.
  await describeDocumentFigures(doc, report, still);

  report({ phase: 'summarizing', message: 'Writing an overview...' });
  await writeOverview(doc.id);
  return { passages: passages.length };
}

/**
 * Runs a claimed import with its heartbeat, records the outcome and reports it (also to watchImport listeners).
 * The document must already be claimed (claimNextImportDb / claimImportDb).
 */
export async function runImport(doc, report = () => {}) {
  const emit = (event) => { report(event); progress.emit(String(doc.id), event); };
  const beat = setInterval(() => heartbeatImportDb(doc.id).catch(() => {}), HEARTBEAT_MS);
  try {
    const { passages } = await importDocument(doc, emit);
    await updateDocumentStatusDb(doc.id, 'ready');
    console.log(`Imported ${doc.name} (document ${doc.id}, ${passages} passages)`);
    emit({ phase: 'done', docId: doc.id, message: `${doc.name} is ready`, chunks: passages });
    return 'ready';
  } catch (err) {
    if (err instanceof Deleted) {
      emit({ phase: 'error', message: 'Document was deleted' });
      return 'deleted';
    }
    console.error(`Import failed: ${doc.name} (document ${doc.id}): ${err.message}`);
    if (await documentExistsDb(doc.id)) await updateDocumentStatusDb(doc.id, 'failed', err.message);
    emit({ phase: 'error', message: err.message });
    return 'failed';
  } finally {
    clearInterval(beat);
  }
}

let running = false;

/** Works through waiting imports, one at a time (call after recording an upload). */
export async function runImportQueue() {
  if (running) return;
  running = true;
  try {
    for (let doc = await claimNextImportDb(STALE_SECONDS); doc; doc = await claimNextImportDb(STALE_SECONDS)) {
      await runImport(doc);
    }
  } catch (err) {
    console.error(`Import queue: ${err.message}`);
  } finally {
    running = false;
  }
}

/** Starts the queue now and checks it regularly, so imports cut off by a restart resume. */
export function startImportWorker() {
  runImportQueue();
  setInterval(runImportQueue, SWEEP_MS).unref();
}

/** Calls listener(event) with a document's import progress until it ends; returns a function that stops it. */
export function watchImport(docId, listener) {
  const key = String(docId);
  progress.on(key, listener);
  return () => progress.off(key, listener);
}
