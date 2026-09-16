CREATE TABLE IF NOT EXISTS app_course_completions (
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  completed_at TIMESTAMPTZ NOT NULL,
  course_revision INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, course_id)
);

CREATE INDEX IF NOT EXISTS app_course_completions_course_idx
  ON app_course_completions (course_id, completed_at);
