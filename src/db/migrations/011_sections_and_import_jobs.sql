-- Passages are stored one per document section (a long section in several parts, no overlap); `section` is the
-- section's number within its document, so search can return whole sections. Documents stored before this get
-- numbers from their headings (a new number where the heading changes).
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS section INTEGER;
UPDATE chunks c SET section = s.n
FROM (
  SELECT id, sum(CASE WHEN heading IS DISTINCT FROM prev THEN 1 ELSE 0 END) OVER (PARTITION BY document_id ORDER BY id) AS n
  FROM (SELECT id, document_id, heading, lag(heading) OVER (PARTITION BY document_id ORDER BY id) AS prev
        FROM chunks WHERE level = 'leaf') t
) s
WHERE c.id = s.id;

-- Search scores every passage of the selected documents exactly (a blended meaning + keyword score, which the
-- vector index could not serve: every search was a full scan of all users' passages). What it needs is to find
-- the selected documents' passages fast.
DROP INDEX IF EXISTS chunks_embedding_idx;
CREATE INDEX IF NOT EXISTS chunks_document_idx ON chunks (document_id, level, section);

-- Imports run as background jobs; a heartbeat shows one is still alive, so an import cut off by a restart is
-- picked up again.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;
