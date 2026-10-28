-- shopbooks: sync store.
-- Every device keeps a full local copy; this table is the cloud copy they sync through.
-- Records are JSON documents keyed by a client-generated id (last write wins by updated_at).

CREATE TABLE IF NOT EXISTS records (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL,
  type        TEXT NOT NULL,
  data        TEXT NOT NULL,          -- JSON document
  updated_at  TEXT NOT NULL,          -- ISO timestamp set by the client that made the change
  deleted     INTEGER NOT NULL DEFAULT 0,
  seq         INTEGER NOT NULL        -- server change counter, used by clients to pull "changes since"
);

CREATE INDEX IF NOT EXISTS records_seq ON records (seq);
CREATE INDEX IF NOT EXISTS records_company_type ON records (company_id, type);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO meta (key, value) VALUES ('seq', '0');
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');
