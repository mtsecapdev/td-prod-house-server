-- Planning workflow: storyline stage, tracked jobs, new deck/doc statuses.
ALTER TABLE generations ADD COLUMN IF NOT EXISTS storyline JSONB;

-- The model work running for a generation, if any: {kind, state: running|failed, error?, started_at, heartbeat_at, progress?}.
-- Lets a second request watch a running job instead of starting another, and lets a restarted server resume.
ALTER TABLE generations ADD COLUMN IF NOT EXISTS job JSONB;

ALTER TABLE generations DROP CONSTRAINT IF EXISTS generations_status_check;
ALTER TABLE generations ADD CONSTRAINT generations_status_check CHECK (status IN (
  -- images (unchanged)
  'pending', 'prompt_ready',
  -- decks and documents: brief -> storyline_ready -> outline_ready -> writing -> done
  'brief', 'storyline_ready', 'outline_ready', 'writing', 'done',
  -- shared; 'generating' is still used by images and older decks
  'generating', 'failed'
));

ALTER TABLE generations DROP CONSTRAINT IF EXISTS generations_type_check;
ALTER TABLE generations ADD CONSTRAINT generations_type_check CHECK (type IN ('deck', 'doc', 'image', 'infographic'));
