import pool from './pool.js';
import { generationName } from './generationsQueries.js';

const FIGURE_COLUMNS = `f.id, f.document_id, f.key, f.page, f.caption, f.labels, f.width, f.height,
  f.description, f.description_status, f.description_edited, f.caption_edited`;

export async function insertFigureDb(documentId, { key, page, caption, labels, filePath, width, height }) {
  await pool.query(
    `INSERT INTO figures (document_id, key, page, caption, labels, file_path, width, height)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (document_id, key) DO NOTHING`,
    [documentId, key, page, caption, labels, filePath, width, height],
  );
}

/** Figures by (document, key) pairs, e.g. those referenced by retrieved passages. */
export async function getFiguresByKeysDb(pairs) {
  if (!pairs.length) return [];
  const res = await pool.query(
    `SELECT ${FIGURE_COLUMNS}
     FROM figures f
     JOIN unnest($1::int[], $2::text[]) AS want(document_id, key) USING (document_id, key)`,
    [pairs.map((p) => p.documentId), pairs.map((p) => p.key)],
  );
  return res.rows;
}

export async function getFigureByIdDb(id) {
  const res = await pool.query(`SELECT ${FIGURE_COLUMNS}, f.file_path FROM figures f WHERE f.id = $1`, [id]);
  return res.rows[0] || null;
}

export async function getFiguresByIdsDb(ids) {
  if (!ids.length) return [];
  const res = await pool.query(`SELECT ${FIGURE_COLUMNS}, f.file_path FROM figures f WHERE f.id = ANY($1)`, [ids]);
  return res.rows;
}

/**
 * Figures for the Assets page and pickers, newest documents first. q matches the caption, the text inside the
 * figure or its description; documentIds limits to those documents.
 */
export async function listFiguresDb({ q, documentIds, ownerId } = {}) {
  const where = [];
  const params = [];
  if (ownerId) {
    params.push(ownerId);
    where.push(`d.owner_id = $${params.length}`);
  }
  if (documentIds?.length) {
    params.push(documentIds);
    where.push(`f.document_id = ANY($${params.length})`);
  }
  if (q?.trim()) {
    params.push(`%${q.trim()}%`);
    where.push(`(f.caption ILIKE $${params.length} OR f.labels ILIKE $${params.length} OR f.description ILIKE $${params.length})`);
  }
  const res = await pool.query(
    `SELECT ${FIGURE_COLUMNS}, d.name AS document_name
     FROM figures f JOIN documents d ON d.id = f.document_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY d.uploaded_at DESC, f.page NULLS LAST, f.id`,
    params,
  );
  return res.rows;
}

/**
 * A person's corrections: { caption?, description? } ('' clears a description). Each edited field is marked,
 * so the model never overwrites it. `redescribe: true` instead hands the description back to the model.
 */
export async function updateFigureDb(id, { caption, description, redescribe = false }) {
  const sets = [];
  const params = [id];
  if (caption !== undefined) {
    params.push(caption);
    sets.push(`caption = $${params.length}`, 'caption_edited = true');
  }
  if (redescribe) {
    sets.push("description_status = 'pending'", 'description_edited = false', 'description_claimed_at = NULL',
      'description_attempts = 0');
  } else if (description !== undefined) {
    params.push(description || null);
    sets.push(`description = $${params.length}`, "description_status = 'done'", 'description_edited = true');
  }
  if (!sets.length) return getFigureByIdDb(id);
  const res = await pool.query(`UPDATE figures f SET ${sets.join(', ')} WHERE f.id = $1 RETURNING ${FIGURE_COLUMNS}`, params);
  return res.rows[0] || null;
}

/**
 * Claims the next figure waiting for a description (or one whose describer stopped heartbeating), from a
 * document that has finished importing, newest documents first. Several servers can share the work.
 */
export async function claimFigureToDescribeDb(staleSeconds) {
  const res = await pool.query(
    `UPDATE figures f SET description_status = 'working', description_claimed_at = NOW()
     FROM documents d
     WHERE f.id = (
       SELECT x.id FROM figures x JOIN documents xd ON xd.id = x.document_id
       WHERE xd.status = 'ready'
         AND (x.description_status = 'pending'
              OR (x.description_status = 'working' AND x.description_claimed_at < NOW() - make_interval(secs => $1)))
       ORDER BY x.document_id DESC, x.id
       FOR UPDATE OF x SKIP LOCKED
       LIMIT 1
     ) AND d.id = f.document_id
     RETURNING f.id, f.caption, f.labels, f.file_path, d.name AS document_name`,
    [staleSeconds],
  );
  return res.rows[0] || null;
}

export async function heartbeatDescribeDb(id) {
  await pool.query("UPDATE figures SET description_claimed_at = NOW() WHERE id = $1 AND description_status = 'working'", [id]);
}

/** Saves the model's description, unless a person wrote one meanwhile. */
export async function saveDescriptionDb(id, description) {
  await pool.query(
    `UPDATE figures SET description = $2, description_status = 'done', description_claimed_at = NULL
     WHERE id = $1 AND description_status = 'working' AND NOT description_edited`,
    [id, description],
  );
}

/** A failed try: the figure waits for another, or is given up on ('failed') after maxAttempts. */
export async function failDescriptionDb(id, maxAttempts) {
  await pool.query(
    `UPDATE figures SET description_attempts = description_attempts + 1, description_claimed_at = NULL,
       description_status = CASE WHEN description_attempts + 1 >= $2 THEN 'failed' ELSE 'pending' END
     WHERE id = $1 AND description_status = 'working'`,
    [id, maxAttempts],
  );
}

/** Deletes the figures and returns their image files (for the caller to remove). */
export async function deleteFiguresDb(ids) {
  const res = await pool.query('DELETE FROM figures WHERE id = ANY($1) RETURNING file_path', [ids]);
  return res.rows.map((r) => r.file_path);
}

/** Figures with their document name, for downloads. */
export async function getFiguresForDownloadDb(ids) {
  const res = await pool.query(
    `SELECT f.id, f.page, f.caption, f.file_path, d.name AS document_name
     FROM figures f JOIN documents d ON d.id = f.document_id
     WHERE f.id = ANY($1) ORDER BY d.name, f.page NULLS LAST, f.id`,
    [ids],
  );
  return res.rows;
}

/**
 * Where figures are used: every slide/section whose plan or content names one of these figure ids.
 * Reads the outlines directly, so it is always current; at large scale this becomes a usage table kept on save.
 */
export async function figureUsageDb(figureIds) {
  if (!figureIds.length) return [];
  const res = await pool.query(
    `SELECT g.id, g.type, g.outline, g.brief, g.name
     FROM generations g
     WHERE g.outline IS NOT NULL
       AND jsonb_path_exists(g.outline, '$.*[*] ? (@.figure_ids[*] == $ids[*] || @.content.pictures[*].figure_id == $ids[*])',
                             jsonb_build_object('ids', to_jsonb($1::int[])))`,
    [figureIds],
  );
  const wanted = new Set(figureIds.map(Number));
  const uses = [];
  for (const g of res.rows) {
    const items = g.outline.slides || g.outline.sections || [];
    const name = generationName(g);
    items.forEach((it, index) => {
      // Written items: the pictures placed on them. Unwritten items: the figures they are planned with.
      const ids = it.content
        ? (it.content.pictures || []).map((p) => Number(p.figure_id))
        : (it.figure_ids || []).map(Number);
      for (const fid of new Set(ids)) {
        if (wanted.has(fid)) uses.push({ figure_id: fid, generation_id: g.id, type: g.type, name, index });
      }
    });
  }
  return uses;
}
