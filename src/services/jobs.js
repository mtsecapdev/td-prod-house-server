// Runs model work for a generation in the background, tracked in the generation row (see generationsQueries).
// Today the work runs in this process; because claim, progress and result all live in Postgres, the same
// calls can later be moved onto a queue worker without changing the API or the client.
import { claimJobDb, failJobDb, updateGenerationDb, withHeartbeat } from '../db/generationsQueries.js';

/**
 * Starts `work` unless another job is running for this generation. `work` resolves to the columns to save
 * (JSON columns already stringified); the job is cleared in the same update.
 * @returns {Promise<boolean>} false when another job holds the slot
 */
export async function startJob(generationId, kind, work) {
  if (!(await claimJobDb(generationId, kind))) return false;
  withHeartbeat(generationId, work)
    .then((fields) => updateGenerationDb(generationId, { ...fields, job: null }))
    .catch(async (err) => {
      console.error(`Generation ${generationId}: ${kind} failed: ${err.message}`);
      await failJobDb(generationId, kind, err.message).catch(() => {});
    });
  return true;
}
