-- The clarifying-questions and storyline screens were removed (Gamma-style flow: prompt -> outline -> write).
-- Their statuses go; rows still at those stages restart at outline planning.
UPDATE generations SET status = 'pending', job = NULL WHERE status IN ('brief', 'storyline_ready');

ALTER TABLE generations DROP CONSTRAINT IF EXISTS generations_status_check;
ALTER TABLE generations ADD CONSTRAINT generations_status_check CHECK (status IN (
  -- images: pending -> prompt_ready -> generating -> done
  -- decks and documents: pending (outline being planned) -> outline_ready -> writing -> done
  'pending', 'prompt_ready', 'outline_ready', 'writing', 'generating', 'done', 'failed'
));
