-- Figures are now described during their document's import (the document is ready only once they are), so the
-- background queue's bookkeeping goes: whether a figure has a description is simply whether description is set.
DROP INDEX IF EXISTS figures_describe_idx;
DROP INDEX IF EXISTS generations_running_job_idx;
ALTER TABLE figures
  DROP COLUMN IF EXISTS description_status,
  DROP COLUMN IF EXISTS description_claimed_at,
  DROP COLUMN IF EXISTS description_attempts;
