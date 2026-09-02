CREATE TABLE IF NOT EXISTS queue_outcomes (
  delivery_id TEXT PRIMARY KEY,
  outcome TEXT NOT NULL,
  occurred_at INTEGER NOT NULL DEFAULT (unixepoch())
);
