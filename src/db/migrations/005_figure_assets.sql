-- Figures as assets: users can hide junk figures from the Assets page and pickers without breaking decks
-- that already use them.
ALTER TABLE figures ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS figures_document_idx ON figures (document_id);
