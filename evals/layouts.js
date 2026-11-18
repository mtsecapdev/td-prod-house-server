// Layout choice eval: runs the planner's layout step over hand-labelled slides (evals/layout-cases.json, Norvane
// report content) in deck-sized batches with the production rules, and scores how many get an acceptable
// layout. Needs Ollama and the database. Run: npm run eval:layouts
// Model answers vary between runs; compare several runs, not one.
import { readFileSync } from 'node:fs';
import { KINDS } from '../src/services/planning/kinds.js';
import { chooseLayouts, finishLayouts } from '../src/services/planning/layouts.js';
import pool from '../src/db/pool.js';

const kind = KINDS.deck;
const cases = JSON.parse(readFileSync(new URL('./layout-cases.json', import.meta.url)));
const brief = { topic: 'Norvane board update on financial position and outlook' };
let pass = 0;
for (let i = 0; i < cases.length; i += 6) {
  const batch = cases.slice(i, i + 6);
  const items = [
    { title: 'Board Update', bullets: ['What the year delivered'], sources: [] },
    ...batch.map((c) => ({ title: c.title, bullets: c.bullets, sources: (c.sources || []).map((id) => ({ chunk_id: id })) })),
    { title: 'Takeaways and Next Steps', bullets: ['Recap'], sources: [] },
  ];
  const out = finishLayouts(kind, brief, await chooseLayouts({ type: 'deck', brief }, kind, items));
  batch.forEach((c, j) => {
    const got = out[j + 1].layout;
    const ok = c.ok.includes(got);
    if (ok) pass++;
    console.log(`${ok ? 'ok ' : 'BAD'} ${got.padEnd(16)} ${c.title}${ok ? '' : `  (acceptable: ${c.ok.join(', ')})`}`);
  });
}
console.log(`\n${pass}/${cases.length} acceptable`);
await pool.end();
