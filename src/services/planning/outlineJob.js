// Starting a deck/document plan: the brief the user (or a conversation) gives, and the background outline job.
import { getGenerationByIdDb, insertGenerationDb, updateGenerationDb } from '../../db/generationsQueries.js';
import { startJob } from '../jobs.js';
import { planOutline } from './planner.js';

const BRIEF_FIELDS = [
  'topic', 'count', 'format', 'text_amount', 'audience', 'tone', 'instructions', 'template', 'source_text', 'text_mode', 'scope',
];
const MAX_SOURCE_TEXT = 60000;
const MAX_PINNED = 16;

/** Keeps only known brief fields, typed; `previous` supplies fields the input leaves out. */
export function normalizeBrief(input = {}, previous = {}) {
  const brief = { ...previous };
  for (const f of BRIEF_FIELDS) {
    if (input[f] === undefined) continue;
    if (f === 'count') brief[f] = Number(input[f]) || undefined;
    else if (f === 'source_text') brief[f] = String(input[f] ?? '').slice(0, MAX_SOURCE_TEXT);
    else brief[f] = String(input[f] ?? '').trim();
  }
  // Passages from the conversation the plan should start from (see planner.planningMaterial).
  if (Array.isArray(input.pinned_chunk_ids)) {
    brief.pinned_chunk_ids = [...new Set(input.pinned_chunk_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, MAX_PINNED);
  }
  return brief;
}

// Plans the outline in the background. The planner suggests an audience and tone; they fill the brief only
// where it left them empty, so the plan opens with them pre-filled.
export async function startOutlineJob(generation) {
  return startJob(generation.id, 'outline', async () => {
    const { storyline, outline } = await planOutline(generation);
    const latest = await getGenerationByIdDb(generation.id);
    const brief = {
      ...latest.brief,
      audience: latest.brief?.audience || storyline.audience,
      tone: latest.brief?.tone || storyline.tone,
    };
    return {
      brief: JSON.stringify(brief),
      storyline: JSON.stringify(storyline),
      outline: JSON.stringify(outline),
      status: 'outline_ready',
    };
  });
}

/** Creates a deck/document from a brief and starts planning it. Returns the generation. */
export async function createPlan({ type, brief, documentIds = [], conversationId = null }) {
  const id = await insertGenerationDb({
    type, brief: JSON.stringify(normalizeBrief(brief)), sourceDocumentIds: documentIds, conversationId,
  });
  await startOutlineJob(await getGenerationByIdDb(id));
  return getGenerationByIdDb(id);
}
