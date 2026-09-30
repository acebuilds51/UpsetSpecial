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

-- 'gen': bumped by every write that passes through (except NO_BUMP_WRITES), and by Apps
--        Script's "stale" signal.
-- 'hgen': the "history" generation (career history copy), bumped only by Apps Script's
--        signal with scope 'history'. Missing = 0 until the first such signal.
-- 'lastStale': when Apps Script last sent that signal (copies are only served once it has).
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO kv (key, value) VALUES ('gen', '1');

-- Per-day counts for /health and the nightly diagnostics (us4). Counts only, no player data.
-- outcome: copy (answered from a copy) / google (Apps Script answered) / stale (Google failed,
-- last copy answered) / failed / write / writeFailed. Rows older than 14 days are pruned.
-- Safe to re-run this whole file: every statement is IF NOT EXISTS / OR IGNORE.
CREATE TABLE IF NOT EXISTS daily (
  day      TEXT NOT NULL,             -- UTC YYYY-MM-DD
  action   TEXT NOT NULL,
  outcome  TEXT NOT NULL,
  n        INTEGER NOT NULL,
  PRIMARY KEY (day, action, outcome)
);
