-- Chat as the workspace: one row per message (instead of the browser saving the whole conversation as JSON),
-- and decks/documents remember the conversation they were made in.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  -- text: a question or answer; generation: a deck/document made here; edit: a change made to one;
  -- agent_plan: proposed deck-wide changes awaiting Apply; error: a failed reply
  kind TEXT NOT NULL DEFAULT 'text',
  content TEXT NOT NULL DEFAULT '',
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, id);

-- Copy existing conversations; answers keep their figures, grounding and the passages they used.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'conversations' AND column_name = 'messages') THEN
    INSERT INTO messages (conversation_id, role, kind, content, data, created_at)
    SELECT c.id,
           CASE WHEN m->>'role' = 'user' THEN 'user' ELSE 'assistant' END,
           CASE WHEN m->>'role' = 'error' THEN 'error' ELSE 'text' END,
           COALESCE(m->>'content', ''),
           jsonb_strip_nulls(jsonb_build_object(
             'figures', m->'figures',
             'grounded', m->'grounded',
             'source_ids', CASE WHEN jsonb_typeof(m->'chunks') = 'object'
                                THEN jsonb_path_query_array(m->'chunks', '$.*[*].id') END
           )),
           c.created_at + (t.n * INTERVAL '1 millisecond')
    FROM conversations c, jsonb_array_elements(c.messages) WITH ORDINALITY AS t(m, n)
    ORDER BY c.id, t.n;
    ALTER TABLE conversations DROP COLUMN messages;
  END IF;
END $$;

ALTER TABLE generations ADD COLUMN IF NOT EXISTS conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS generations_conversation_idx ON generations (conversation_id);
