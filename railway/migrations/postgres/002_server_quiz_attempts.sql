CREATE TABLE IF NOT EXISTS app_quiz_attempts (
  id VARCHAR(100) PRIMARY KEY NOT NULL,
  user_id VARCHAR(100) NOT NULL REFERENCES app_users (id) ON DELETE CASCADE,
  course_id VARCHAR(100) NOT NULL REFERENCES courses (id) ON DELETE RESTRICT,
  lesson_id VARCHAR(100) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  score INTEGER NOT NULL CHECK (score >= 0),
  question_count INTEGER NOT NULL CHECK (question_count > 0),
  attempts_used INTEGER NOT NULL CHECK (attempts_used > 0),
  passed INTEGER NOT NULL DEFAULT 0 CHECK (passed IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('failed', 'exhausted', 'passed')),
  answers_json JSONB NOT NULL,
  results_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS app_quiz_attempts_user_course_idx
  ON app_quiz_attempts (user_id, course_id, created_at DESC);

UPDATE app_meta
SET value = '5', updated_at = now()
WHERE key = 'schema_version';
