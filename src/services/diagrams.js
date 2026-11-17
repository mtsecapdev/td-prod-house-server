// Diagrams for slides and document sections: the model writes Mermaid, the render service turns it into a PNG.
// Shared by the planning writer and editChat.
import { createHash } from 'node:crypto';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import config from '../config.js';
import { chatStructured } from './llm.js';

const RENDER_TIMEOUT_MS = 30_000;
const KEY_RE = /^[a-f0-9]{16}$/;
// Part of the file key. Bump when the renderer's output changes (scale, theme, fonts) so cached PNGs aren't
// reused; `npm run rerender-diagrams` then refreshes existing slides and sections.
export const RENDER_VERSION = 2;

export const DIAGRAM_TYPES = ['flowchart', 'sequence', 'mindmap'];

/** Mermaid writing rules, included in every prompt that produces mermaid_code. */
export function mermaidGuide({ direction = 'LR' } = {}) {
  return (
    `The mermaid_code field must be VALID Mermaid syntax, with no code fences.\n` +
    `Diagram types:\n` +
    `- flowchart: start with "flowchart ${direction}". Connect nodes with A[Label] --> B[Label]. ` +
    `Use B{Question?} for decisions and label branches like B -- Yes --> C.\n` +
    `- sequence: start with "sequenceDiagram". Declare participants, then use ->> for messages and -->> for replies.\n` +
    `- mindmap: start with "mindmap", then the root on the next line, and indent child nodes with spaces.\n` +
    `Rules:\n` +
    `- Pick the type from the content: flowchart for processes and decisions, sequence for interactions between ` +
    `people or systems, mindmap for a topic broken into parts.\n` +
    `- Keep labels short (max 5 words). Use 4-10 nodes for flowcharts, 2-6 participants for sequences, 4-10 leaves for mindmaps.\n` +
    `- Node IDs are single words without spaces (A, B, step1). Put the readable text in the label.\n` +
    `- If a label contains punctuation such as (, ), :, ", / or &, wrap the whole label in double quotes: A["Check (daily)"].\n` +
    `- No HTML, no styling directives, no click or link statements.\n` +
    `- Use only facts from the source material.`
  );
}

export class DiagramSyntaxError extends Error {}

export function diagramDir(generationId) {
  return join(config.outputDir, 'diagrams', String(Number(generationId)));
}

/** Path of a rendered diagram, or null if the key is malformed (keys come from URLs). */
export function diagramPath(generationId, key) {
  if (!KEY_RE.test(String(key))) return null;
  return join(diagramDir(generationId), `${key}.png`);
}

export async function deleteDiagrams(generationId) {
  await rm(diagramDir(generationId), { recursive: true, force: true });
}

function cleanCode(code) {
  return String(code || '')
    .trim()
    .replace(/^```(?:mermaid)?\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

/**
 * Renders Mermaid to <outputDir>/diagrams/<generationId>/<hash>.png and returns the hash.
 * Files are named by content, so reordering slides never breaks the link, identical code renders once,
 * and undo can point back at an older file. Throws DiagramSyntaxError with Mermaid's message for invalid code.
 */
export async function renderDiagram(generationId, rawCode) {
  const code = cleanCode(rawCode);
  if (!code) throw new DiagramSyntaxError('The diagram has no Mermaid code.');

  const key = createHash('sha256').update(`v${RENDER_VERSION}\n${code}`).digest('hex').slice(0, 16);
  const file = diagramPath(generationId, key);
  try {
    await access(file);
    return key;
  } catch {
    // not rendered yet
  }

  let res;
  try {
    res = await fetch(`${config.renderer.endpoint}/render/mermaid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Diagram render service unreachable at ${config.renderer.endpoint}: ${err.message}`);
  }
  if (res.status === 422) {
    const { error } = await res.json();
    throw new DiagramSyntaxError(error);
  }
  if (!res.ok) throw new Error(`Diagram render service returned ${res.status}: ${await res.text()}`);

  await mkdir(diagramDir(generationId), { recursive: true });
  // Write then rename so a concurrent reader never sees a half-written file.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  await rename(tmp, file);
  return key;
}

/**
 * Renders content.mermaid_code. If Mermaid rejects it, gives the model the error and asks for a fix once.
 * Returns the content (possibly corrected) with diagram_file set. Throws DiagramSyntaxError if still invalid.
 */
export async function renderWithRepair(generationId, content, schema) {
  const withCleanCode = { ...content, mermaid_code: cleanCode(content.mermaid_code) };
  try {
    return { ...withCleanCode, diagram_file: await renderDiagram(generationId, withCleanCode.mermaid_code) };
  } catch (err) {
    if (!(err instanceof DiagramSyntaxError)) throw err;

    const { diagram_file: _old, source_chunk_ids: _ids, ...forModel } = withCleanCode;
    const fixed = await chatStructured(
      [
        {
          role: 'system',
          content:
            `You fix Mermaid diagrams that fail to parse. Return the same JSON with mermaid_code corrected. ` +
            `Keep the meaning, labels and every other field unchanged unless the error requires otherwise.\n\n` +
            mermaidGuide(),
        },
        { role: 'user', content: `JSON:\n${JSON.stringify(forModel, null, 2)}\n\nMermaid error:\n${err.message}` },
      ],
      config.ollama.generateModel,
      schema,
      { think: true },
    );
    const code = cleanCode(fixed.mermaid_code);
    // Merge over the original so fields the schema doesn't cover (source_chunk_ids) survive.
    return { ...withCleanCode, ...fixed, mermaid_code: code, diagram_file: await renderDiagram(generationId, code) };
  }
}
