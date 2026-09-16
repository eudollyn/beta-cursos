CREATE TABLE IF NOT EXISTS app_quiz_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES app_users (id) ON DELETE CASCADE,
  course_id TEXT NOT NULL REFERENCES courses (id) ON DELETE RESTRICT,
  lesson_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score >= 0),
  question_count INTEGER NOT NULL CHECK (question_count > 0),
  attempts_used INTEGER NOT NULL CHECK (attempts_used > 0),
  passed INTEGER NOT NULL DEFAULT 0 CHECK (passed IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('failed', 'exhausted', 'passed')),
  answers_json TEXT NOT NULL,
  results_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS app_quiz_attempts_user_course_idx
  ON app_quiz_attempts (user_id, course_id, created_at DESC);

UPDATE app_meta
SET value = '5', updated_at = CURRENT_TIMESTAMP
WHERE key = 'schema_version';
