-- A copy saved to the Library is its own file: deleting the deck/document (or the conversation it was made in)
-- keeps the copy and only drops the link back to it.
ALTER TABLE assets ALTER COLUMN generation_id DROP NOT NULL;
ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_generation_id_fkey;
ALTER TABLE assets ADD CONSTRAINT assets_generation_id_fkey
  FOREIGN KEY (generation_id) REFERENCES generations(id) ON DELETE SET NULL;
