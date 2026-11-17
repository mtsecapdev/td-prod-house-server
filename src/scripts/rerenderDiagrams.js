// Re-renders every diagram in every deck and document (after a renderer change bumps RENDER_VERSION) and
// points each slide/section at its new PNG. Old PNGs are left on disk; undo history may still reference them.
import pool from '../db/pool.js';
import { renderDiagram } from '../services/diagrams.js';

const { rows } = await pool.query(`SELECT id, type, outline FROM generations WHERE type IN ('deck', 'doc') AND outline IS NOT NULL`);
let rendered = 0;
let failed = 0;

for (const gen of rows) {
  const listKey = gen.type === 'deck' ? 'slides' : 'sections';
  const items = gen.outline[listKey] || [];
  let changed = false;

  for (const item of items) {
    const c = item.content;
    if (!c?.mermaid_code) continue;
    try {
      const key = await renderDiagram(gen.id, c.mermaid_code);
      if (key !== c.diagram_file) {
        c.diagram_file = key;
        changed = true;
      }
      rendered++;
    } catch (err) {
      failed++;
      console.error(`Generation ${gen.id}: ${err.message.split('\n')[0]}`);
    }
  }

  if (changed) {
    await pool.query('UPDATE generations SET outline = $1, updated_at = NOW() WHERE id = $2', [JSON.stringify(gen.outline), gen.id]);
  }
}

console.log(`Re-rendered ${rendered} diagram(s) across ${rows.length} generation(s); ${failed} failed.`);
await pool.end();
