-- What each figure shows, written by a vision model in the background after import (figures can then be picked
-- by what the picture shows, not only by a caption that may promise more). People can correct the caption and
-- the description; an edited one is marked and never overwritten by the model.
-- description_status: 'pending' (waiting), 'working' (claimed; claimed_at is its heartbeat), 'done', 'failed'.
-- Figures stored before this start as pending, so they are described too.
ALTER TABLE figures
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS description_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (description_status IN ('pending', 'working', 'done', 'failed')),
  ADD COLUMN IF NOT EXISTS description_claimed_at TIMESTAMPTZ,
  -- Failed tries; a figure is given up on ('failed') after a few, so a model that is down doesn't fail them all.
  ADD COLUMN IF NOT EXISTS description_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS description_edited BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS caption_edited BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS figures_describe_idx ON figures (id) WHERE description_status IN ('pending', 'working');

-- Describing waits while any deck or document is being generated; this finds a running job without a scan.
CREATE INDEX IF NOT EXISTS generations_running_job_idx ON generations (id) WHERE job->>'state' = 'running';
