CREATE TABLE IF NOT EXISTS app_video_progress (
  user_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  tracking_cycle INTEGER NOT NULL DEFAULT 1,
  duration_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  watched_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  percentage DOUBLE PRECISION NOT NULL DEFAULT 0,
  last_position_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  intervals_json TEXT NOT NULL DEFAULT '[]',
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, course_id, lesson_id)
);

CREATE INDEX IF NOT EXISTS app_video_progress_user_idx
  ON app_video_progress (user_id, course_id, updated_at DESC);
