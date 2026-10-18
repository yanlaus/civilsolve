-- The usage log (worker/usage.ts): one row per model-calling task, and one
-- per PDF asked for. Metadata only - never the pages, notes, prompts or
-- answers. Kept for good, IP addresses included (the owner's call,
-- 18 October 2026).
CREATE TABLE usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- When it was asked and when it ended, in ms since the epoch (UTC).
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  -- Who asked: the client IP and country Cloudflare saw.
  ip TEXT,
  country TEXT,
  -- The TaskJob's id (or the PDF's).
  job_id TEXT,
  -- solve | interpret | judge | study | ask | align | pdf
  kind TEXT NOT NULL,
  -- interpret: read | reconcile | revise; study: approach | explain;
  -- pdf: cache | kept | made.
  detail TEXT,
  -- 1 for a re-generation with the student's instructions.
  revision INTEGER NOT NULL DEFAULT 0,
  provider TEXT,
  variant TEXT,
  -- The thinking level asked for, then the one the last attempt used.
  effort TEXT,
  -- Which question: the first 16 hex digits of a SHA-256 over its pages, so
  -- the readings, solutions, cross-check and notes of one question share it.
  question TEXT,
  pages INTEGER,
  notes_pages INTEGER,
  -- The solutions a cross-check or notes request was given; answers compared.
  solutions INTEGER,
  -- The model and channel of the last attempt (the one that answered).
  model TEXT,
  channel TEXT,
  -- Upstream requests made: every attempt, retry and fallback.
  model_calls INTEGER,
  -- running | done | error | timeout | cancelled | rejected | rate-limited
  outcome TEXT NOT NULL,
  duration_ms INTEGER,
  error TEXT
);

CREATE INDEX usage_log_started_at ON usage_log (started_at);
CREATE INDEX usage_log_ip ON usage_log (ip, started_at);
CREATE INDEX usage_log_question ON usage_log (question);
