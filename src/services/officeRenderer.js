// Renders a deck or document generation to .pptx / .docx with the Python scripts.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import config from '../config.js';
import { ensureDiagramFile } from './diagrams.js';
import { getTemplate } from './templates.js';
import { generationName } from '../db/generationsQueries.js';
import { getFiguresByIdsDb } from '../db/figuresQueries.js';
import { layoutSlide } from '../../shared/slides/layout.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

export const OFFICE_MIME = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export function officeExt(generation) {
  return generation.type === 'deck' ? 'pptx' : 'docx';
}

/** Error message if the generation has nothing to render yet, otherwise null. */
export function notReadyMessage(generation) {
  if (generation.type === 'deck' && !generation.outline?.slides?.length) return 'No slides generated yet';
  if (generation.type === 'doc' && !generation.outline?.sections?.length) return 'No sections generated yet';
  return null;
}

// What the Python scripts read: the outline, the template's colours and fonts, and absolute paths of the
// diagrams in that template (rendered now if the template changed after writing).
async function renderInput(generation) {
  const listKey = generation.type === 'deck' ? 'slides' : 'sections';
  const all = generation.outline[listKey] || [];
  // Pictures (document figures) get their files' paths; a deleted one renders as removed.
  const pictures = all.flatMap((it) => it.content?.pictures || []);
  const figureIds = [...new Set(pictures.map((p) => Number(p.figure_id)).filter(Boolean))];
  const figurePaths = new Map((await getFiguresByIdsDb(figureIds)).map((f) => [f.id, f.file_path]));
  const pathOf = (p) => figurePaths.get(Number(p.figure_id)) || null;
  const items = await Promise.all(all.map(async (item) => {
    let content = item.content;
    if (!content) return item;
    if (content.pictures?.length) {
      content = { ...content, pictures: content.pictures.map((p) => ({ ...p, path: pathOf(p) })) };
    }
    if (content.diagram_file) content = { ...content, diagram_path: await ensureDiagramFile(generation, content.diagram_file) };
    return { ...item, content };
  }));
  // Decks: every slide's boxes from the layout engine; render_pptx.py only draws them.
  if (generation.type === 'deck') {
    items.forEach((item, i) => {
      if (!item.content) return;
      const { background, boxes, pictureBoxes } = layoutSlide(item, i + 1);
      items[i] = { ...item, background, boxes, picture_boxes: pictureBoxes };
    });
  }
  const { pptx_path: templatePath, ...theme } = await getTemplate(generation.brief?.template);
  return { input: { ...generation.outline, [listKey]: items, theme }, templatePath };
}

/**
 * Renders the file and returns its path. Every call writes to its own file name, so concurrent downloads
 * of the same generation never overwrite each other, and Library copies stay as they were saved.
 * @param {'temp' | 'keep'} mode  temp files go under outputDir/tmp and the caller deletes them
 */
export async function renderOfficeFile(generation, mode = 'temp') {
  const ext = officeExt(generation);
  const outDir = mode === 'temp' ? join(config.outputDir, 'tmp') : join(config.outputDir, ext);
  await mkdir(outDir, { recursive: true });

  const stem = `${generation.id}_${randomUUID()}`;
  const inputPath = join(outDir, `${stem}_input.json`);
  const outputPath = join(outDir, `${stem}.${ext}`);
  const scriptPath = join(__dirname, '..', '..', 'scripts', ext === 'pptx' ? 'render_pptx.py' : 'render_docx.py');

  const { input, templatePath } = await renderInput(generation);
  await writeFile(inputPath, JSON.stringify(input), 'utf-8');
  // A company template (.pptx) is the base file for decks, so its masters (logos, backgrounds) carry over.
  const args = [scriptPath, inputPath, outputPath, ...(ext === 'pptx' && templatePath ? [templatePath] : [])];
  try {
    await execFileAsync(config.pythonPath, args, { timeout: 60_000 });
  } catch (err) {
    throw new Error(`${ext.toUpperCase()} rendering failed: ${err.stderr || err.message}`);
  } finally {
    await unlink(inputPath).catch(() => {});
  }
  return outputPath;
}

export function downloadName(generation, ext) {
  const name = generationName(generation).replace(/[^a-zA-Z0-9 _&-]/g, '').slice(0, 60).trim();
  return `${name || generation.type}.${ext}`;
}
