-- Accounts: an admin creates users (no self sign-up); sessions live in the database so several app servers can
-- share them. Documents, conversations, decks/documents and Library copies belong to the user who made them.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  -- scrypt$N$r$p$salt$hash (services/auth.js)
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  -- Set for a new account and after an admin resets the password: the user must choose their own first.
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_idx ON users (lower(username));

CREATE TABLE IF NOT EXISTS sessions (
  -- SHA-256 of the cookie's token: a leaked database doesn't hand out working sessions.
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

-- Owners. Rows from before accounts have none and are visible to nobody (they are deleted separately).
ALTER TABLE documents ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE generations ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS documents_owner_idx ON documents (owner_id);
CREATE INDEX IF NOT EXISTS conversations_owner_idx ON conversations (owner_id);
CREATE INDEX IF NOT EXISTS generations_owner_idx ON generations (owner_id);
CREATE INDEX IF NOT EXISTS assets_owner_idx ON assets (owner_id);

-- Brand templates are shared by everyone; the uploader (or an admin) can delete one.
ALTER TABLE brand_templates ADD COLUMN IF NOT EXISTS uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
