-- Upset Special front door (Cloudflare D1). See docs/cloudflare-front-door-plan.md.
-- Apply with: npx wrangler d1 execute upset-special --remote --file=schema.sql

-- The Worker's last good answer to each busy read (phase 2). Served only while `gen` equals
-- the current generation (kv 'gen') and it is younger than that read's max age. The Sheet
-- stays the source of truth: a stale or missing copy just means the read goes to Apps Script.
CREATE TABLE IF NOT EXISTS copies (
  key        TEXT PRIMARY KEY,        -- action + the parameters that change its answer
  json       TEXT NOT NULL,           -- exactly what Apps Script answered
  gen        INTEGER NOT NULL,        -- generation when the request that produced it started
  stored_at  INTEGER NOT NULL         -- ms
);

-- 'gen': bumped by every write that passes through, and by Apps Script's "stale" signal.
-- 'lastStale': when Apps Script last sent that signal (copies are only served once it has).
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO kv (key, value) VALUES ('gen', '1');
