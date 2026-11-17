// Visual templates (colours + fonts) for decks and documents, shared with the Python renderers, the diagram
// renderer and the client preview. Source of truth: templates/themes.json.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'themes.json');
const data = JSON.parse(readFileSync(file, 'utf-8'));
const byId = new Map(data.templates.map((t) => [t.id, t]));

export function listTemplates() {
  return { default: data.default, templates: data.templates };
}

/** The template with this id, or the default for unknown/missing ids. */
export function getTemplate(id) {
  return byId.get(id) || byId.get(data.default);
}
