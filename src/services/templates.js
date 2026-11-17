// Visual templates (colours + fonts) for decks and documents: the built-in ones in templates/themes.json, plus
// company templates uploaded as .pptx (brand_templates table, ids "brand_<n>"). Shared with the Python
// renderers, the diagram renderer and the client preview.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import config from '../config.js';
import {
  insertBrandTemplateDb, listBrandTemplatesDb, getBrandTemplateDb, deleteBrandTemplateDb,
} from '../db/brandTemplatesQueries.js';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(here, '..', '..', 'templates', 'themes.json'), 'utf-8'));
const builtIn = new Map(data.templates.map((t) => [t.id, t]));
const BRAND_PREFIX = 'brand_';

export const TEMPLATE_ID_RE = /^[a-z0-9_]{1,40}$/;

function fromBrandRow(row) {
  return {
    id: `${BRAND_PREFIX}${row.id}`,
    name: row.name,
    description: 'Uploaded company template',
    custom: true,
    colors: row.colors,
    fonts: row.fonts,
    pptx_path: row.pptx_path, // server-only; stripped from API responses
  };
}

/** Built-in templates followed by uploaded company templates (without file paths). */
export async function listTemplates() {
  const brands = (await listBrandTemplatesDb()).map(fromBrandRow).map(({ pptx_path: _p, ...t }) => t);
  return { default: data.default, templates: [...data.templates, ...brands] };
}

/** The template with this id (built-in or uploaded), or the default for unknown/missing ids. */
export async function getTemplate(id) {
  if (builtIn.has(id)) return builtIn.get(id);
  if (typeof id === 'string' && id.startsWith(BRAND_PREFIX)) {
    const row = await getBrandTemplateDb(Number(id.slice(BRAND_PREFIX.length)));
    if (row) return fromBrandRow(row);
  }
  return builtIn.get(data.default);
}

/** Reads a company .pptx's theme, stores the file and its mapped colours/fonts, returns the new template. */
export async function createBrandTemplate(buffer, name) {
  const dir = join(config.outputDir, 'brand');
  await mkdir(dir, { recursive: true });
  const pptxPath = join(dir, `${randomUUID()}.pptx`);
  await writeFile(pptxPath, buffer);

  let theme;
  try {
    const { stdout } = await execFileAsync(config.pythonPath, [join(here, '..', '..', 'scripts', 'extract_brand.py'), pptxPath], { timeout: 30_000 });
    theme = JSON.parse(stdout);
  } catch (err) {
    await unlink(pptxPath).catch(() => {});
    throw new Error(`Could not read that template's theme: ${(err.stderr || err.message).split('\n').filter(Boolean).pop()}`);
  }
  const id = await insertBrandTemplateDb({ name, pptxPath, colors: theme.colors, fonts: theme.fonts });
  const { pptx_path: _p, ...template } = fromBrandRow({ id, name, pptx_path: pptxPath, colors: theme.colors, fonts: theme.fonts });
  return template;
}

export async function deleteBrandTemplate(id) {
  if (!String(id).startsWith(BRAND_PREFIX)) throw new Error('Built-in templates cannot be deleted');
  const row = await deleteBrandTemplateDb(Number(String(id).slice(BRAND_PREFIX.length)));
  if (row) await unlink(row.pptx_path).catch(() => {});
  return Boolean(row);
}
