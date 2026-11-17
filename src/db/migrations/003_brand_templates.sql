-- Company templates uploaded as .pptx: theme colours/fonts mapped to the app's template tokens, plus the file,
-- whose slide masters the PPTX renderer builds on.
CREATE TABLE IF NOT EXISTS brand_templates (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  pptx_path TEXT NOT NULL,
  colors JSONB NOT NULL,
  fonts JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
