// Describing figures: the vision model looks at each figure and writes what it shows, so figure picking (and
// chat) go by the picture, not only by a caption that can promise more than it shows. Done as a step of the
// import: a document is ready only once its figures are described, so every ready document has them. A figure
// the model fails on (twice) is left without one; its owner can write one or ask again on the Assets page.
import { readFile } from 'node:fs/promises';
import config from '../config.js';
import { describeFigure } from './llm.js';
import { getDocumentFiguresDb, updateFigureDb } from '../db/figuresQueries.js';

const TRIES = 2;
// The subject is one sentence saying what the picture shows; fewer words than this is not one.
const MIN_SUBJECT_WORDS = 3;

/** One figure's description ({ caption, labels, file_path }), or null when the model fails on it. */
export async function describeOne(figure, documentName) {
  const png = await readFile(figure.file_path);
  for (let attempt = 1; ; attempt++) {
    try {
      const answer = await describeFigure({ png, caption: figure.caption, labels: figure.labels, documentName });
      const words = answer?.subject.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length || 0;
      if (words >= MIN_SUBJECT_WORDS) return answer.text;
      throw new Error(`not a description: ${JSON.stringify(answer?.subject || '')}`);
    } catch (err) {
      console.warn(`Describing figure ${figure.id} failed (try ${attempt} of ${TRIES}): ${err.message}`);
      if (attempt >= TRIES) return null;
    }
  }
}

/**
 * Describes every figure of a document (during its import). `report(event)` gets progress; `still()` throws
 * if the document was deleted meanwhile. Does nothing without a vision model (VISION_MODEL_NAME).
 */
export async function describeDocumentFigures(doc, report, still) {
  if (!config.ollama.visionModel) return;
  const figures = await getDocumentFiguresDb(doc.id);
  for (let i = 0; i < figures.length; i++) {
    report({ phase: 'describing', message: `Describing figures (${i + 1} of ${figures.length})...`, current: i, total: figures.length });
    const description = await describeOne(figures[i], doc.name);
    await still();
    if (description) await updateFigureDb(figures[i].id, { description, byModel: true });
  }
}
