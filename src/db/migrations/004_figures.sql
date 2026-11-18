-- Figures found in ingested documents: caption, the text printed inside them, page, and the saved image.
-- Passages that contain a figure carry a "<!-- figure:KEY -->" marker linking them to the row here.
CREATE TABLE IF NOT EXISTS figures (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  page INTEGER,
  caption TEXT NOT NULL DEFAULT '',
  labels TEXT NOT NULL DEFAULT '',
  file_path TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  UNIQUE (document_id, key)
);
