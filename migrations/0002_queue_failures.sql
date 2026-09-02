CREATE TABLE IF NOT EXISTS queue_failures (
  delivery_id TEXT PRIMARY KEY,
  error TEXT NOT NULL,
  occurred_at INTEGER NOT NULL DEFAULT (unixepoch())
);
