import AppError from '../utils/AppError.js';
import pool from './pool.js';

export async function insertGenerationDb({ type, brief, sourceDocumentIds, model, settings }) {
  const res = await pool.query(
    `INSERT INTO generations (type, brief, source_document_ids, model, settings)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [type, brief, sourceDocumentIds, model, settings],
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

export async function getAllGenerationsDb() {
  const res = await pool.query(
    'SELECT id, type, status, brief, job, created_at, updated_at FROM generations ORDER BY created_at DESC',
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

/** What clients see: a running job whose heartbeat stopped is reported as failed, so the UI offers a retry. */
export function presentGeneration(generation) {
  const { job } = generation;
  if (job?.state === 'running' && !isJobLive(job)) {
    return { ...generation, job: { ...job, state: 'failed', error: 'Interrupted (the server restarted). Try again.' } };
  }
  return generation;
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
