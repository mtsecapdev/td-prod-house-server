import AppError from '../utils/AppError.js';
import pool from './pool.js';

export async function insertGenerationDb({ type, brief, sourceDocumentIds, model, settings, conversationId = null, ownerId }) {
  if (!ownerId) throw new AppError('A deck, document or image needs an owner', 500);
  const res = await pool.query(
    `INSERT INTO generations (type, brief, source_document_ids, model, settings, conversation_id, owner_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [type, brief, sourceDocumentIds, model, settings, conversationId, ownerId],
  );
  return res.rows[0].id;
}

export async function getGenerationByIdDb(id) {
  const res = await pool.query('SELECT * FROM generations WHERE id = $1', [id]);
  if (res.rowCount === 0) throw new AppError(`Generation ${id} not found`, 404);
  return res.rows[0];
}

export async function updateGenerationDb(id, fields) {
  const sets = [];
  const values = [];
  let i = 1;

  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = $${i++}`);
    values.push(value);
  }

  sets.push(`updated_at = NOW()`);
  values.push(id);

  await pool.query(
    `UPDATE generations SET ${sets.join(', ')} WHERE id = $${i}`,
    values,
  );
}

export async function getAllGenerationsDb(ownerId) {
  const res = await pool.query(
    `SELECT id, type, status, brief, job, conversation_id, created_at, updated_at,
       coalesce(outline->'slides'->0->'content'->>'title', outline->'sections'->0->'content'->>'title') AS first_title
     FROM generations WHERE owner_id = $1 ORDER BY created_at DESC`,
    [ownerId],
  );
  return res.rows;
}

export async function deleteGenerationDb(id) {
  const res = await pool.query('DELETE FROM generations WHERE id = $1', [id]);
  if (res.rowCount === 0) throw new AppError(`Generation ${id} not found`, 404);
}

// ── Jobs ──
// A generation runs at most one model job at a time. The job lives in the row (not in server memory), so any
// server instance can see it, a second request can watch instead of starting a duplicate, and a job whose
// heartbeat stopped (server restart) can be taken over.

// Running jobs heartbeat every JOB_HEARTBEAT_MS; one silent for JOB_STALE_MS died with its server process.
export const JOB_HEARTBEAT_MS = 30 * 1000;
export const JOB_STALE_MS = 90 * 1000;

/** Claims the job slot. Returns false if another live job is running for this generation. */
export async function claimJobDb(id, kind) {
  const job = { kind, state: 'running', started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() };
  const res = await pool.query(
    `UPDATE generations SET job = $2, updated_at = NOW()
     WHERE id = $1 AND (
       job IS NULL OR job->>'state' <> 'running'
       OR (job->>'heartbeat_at')::timestamptz < NOW() - ($3 || ' milliseconds')::interval
     )
     RETURNING id`,
    [id, JSON.stringify(job), String(JOB_STALE_MS)],
  );
  return res.rowCount === 1;
}

export async function heartbeatJobDb(id, progress) {
  await pool.query(
    `UPDATE generations
     SET job = job || jsonb_build_object('heartbeat_at', NOW())
               || CASE WHEN $2::jsonb IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('progress', $2::jsonb) END,
         updated_at = NOW()
     WHERE id = $1 AND job->>'state' = 'running'`,
    [id, progress === undefined ? null : JSON.stringify(progress)],
  );
}

export async function failJobDb(id, kind, error) {
  const job = { kind, state: 'failed', error, failed_at: new Date().toISOString() };
  await pool.query(`UPDATE generations SET job = $2, updated_at = NOW() WHERE id = $1`, [id, JSON.stringify(job)]);
}

export function isJobLive(job) {
  return job?.state === 'running' && Date.now() - new Date(job.heartbeat_at).getTime() < JOB_STALE_MS;
}

/**
 * The deck's or document's name: the title its first slide/section was written with. The brief's topic is
 * the user's request ("Financial report for the board, include diagrams"), not a name; it is only the
 * fallback until the title slide exists.
 */
export function generationName(generation) {
  const first = generation.outline?.slides?.[0] || generation.outline?.sections?.[0];
  const title = first?.content?.title || generation.first_title;
  if (title) return title;
  const topic = (generation.brief?.topic || '').split('\n')[0].trim();
  return topic.length > 80 ? `${topic.slice(0, 77).replace(/\s+\S*$/, '')}…` : topic || 'Untitled';
}

/** What clients see: the name, and a running job whose heartbeat stopped reported as failed (so the UI offers a retry). */
export function presentGeneration(generation) {
  const { job, first_title: _t, ...rest } = generation;
  const presented = { ...rest, job, name: generationName(generation) };
  if (job?.state === 'running' && !isJobLive(job)) {
    presented.job = { ...job, state: 'failed', error: 'Interrupted (the server restarted). Try again.' };
  }
  return presented;
}

/** Keeps a job's heartbeat fresh while `work` runs. */
export async function withHeartbeat(id, work) {
  const timer = setInterval(() => { heartbeatJobDb(id).catch(() => {}); }, JOB_HEARTBEAT_MS);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

/** Saved files of generated images, for pictures placed on slides/sections. */
export async function getImagePathsDb(ids) {
  if (!ids.length) return [];
  const res = await pool.query(
    "SELECT id, outline->>'file_path' AS file_path FROM generations WHERE type = 'image' AND id = ANY($1)",
    [ids],
  );
  return res.rows.filter((r) => r.file_path);
}
