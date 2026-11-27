// Describing figures, in the background: after import, the vision model looks at each figure and writes what
// it shows, so figure picking (and chat) can go by the picture, not only its caption. Runs in the import queue,
// one figure at a time, after any waiting imports, and waits while a deck or document is being generated (the
// GPU serves one model call at a time; people waiting on a generation come first). The claim and its heartbeat
// live in Postgres, so a restart or several app servers don't describe a figure twice or leave one stuck.
// A description a person wrote is never replaced (saveDescriptionDb checks).
import { readFile } from 'node:fs/promises';
import config from '../config.js';
import { describeFigure } from './llm.js';
import {
  claimFigureToDescribeDb, heartbeatDescribeDb, saveDescriptionDb, failDescriptionDb,
} from '../db/figuresQueries.js';
import { anyJobLiveDb } from '../db/generationsQueries.js';

const HEARTBEAT_MS = 10_000;
const STALE_SECONDS = 60;
const MAX_ATTEMPTS = 3;

/**
 * Describes the next waiting figure. Returns false when there is nothing more to do now: no vision model set,
 * a generation running, no figure waiting, or this try failed (the next check of the queue tries again, so a
 * model that is down is not hammered).
 */
export async function describeNextFigure() {
  if (!config.ollama.visionModel || await anyJobLiveDb()) return false;
  const figure = await claimFigureToDescribeDb(STALE_SECONDS);
  if (!figure) return false;
  const beat = setInterval(() => heartbeatDescribeDb(figure.id).catch(() => {}), HEARTBEAT_MS);
  try {
    const png = await readFile(figure.file_path);
    const description = await describeFigure({ png, caption: figure.caption, labels: figure.labels, documentName: figure.document_name });
    if (!description) throw new Error('empty description');
    await saveDescriptionDb(figure.id, description);
    return true;
  } catch (err) {
    console.error(`Describing figure ${figure.id} failed: ${err.message}`);
    await failDescriptionDb(figure.id, MAX_ATTEMPTS).catch(() => {});
    return false;
  } finally {
    clearInterval(beat);
  }
}
