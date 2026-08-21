CREATE TABLE IF NOT EXISTS installations (
  team_id TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS links (
  state TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS grants (
  subject TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS pending_entries (
  entry_id TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  confirmation_message_ts TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS links_expiry_idx ON links (expires_at);
CREATE INDEX IF NOT EXISTS pending_entries_expiry_idx ON pending_entries (expires_at);
CREATE INDEX IF NOT EXISTS pending_entries_message_idx
  ON pending_entries (channel_id, confirmation_message_ts);
CREATE INDEX IF NOT EXISTS deliveries_expiry_idx ON deliveries (expires_at);
