CREATE TABLE IF NOT EXISTS admins (
  email TEXT PRIMARY KEY NOT NULL,
  full_name VARCHAR(160) NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS admins_single_owner_idx
  ON admins (role) WHERE role = 'owner';

CREATE TABLE IF NOT EXISTS courses (
  id VARCHAR(100) PRIMARY KEY NOT NULL,
  slug VARCHAR(80) NOT NULL UNIQUE,
  title VARCHAR(180) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  data_json JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS courses_slug_unique ON courses (slug);
CREATE INDEX IF NOT EXISTS courses_status_updated_idx ON courses (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS media (
  id VARCHAR(100) PRIMARY KEY NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  filename VARCHAR(180) NOT NULL,
  content_type TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pdf', 'video', 'image')),
  size BIGINT NOT NULL CHECK (size > 0),
  sha256 CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS media_storage_key_unique ON media (storage_key);
CREATE INDEX IF NOT EXISTS media_kind_created_idx ON media (kind, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO app_meta (key, value, updated_at)
VALUES ('schema_version', '4', now())
ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

CREATE TABLE IF NOT EXISTS app_users (
  id VARCHAR(100) PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE,
  full_name VARCHAR(160) NOT NULL,
  password_hash TEXT NOT NULL,
  member_code TEXT,
  member_code_validated INTEGER NOT NULL DEFAULT 0 CHECK (member_code_validated IN (0, 1)),
  role TEXT NOT NULL DEFAULT 'student'
    CHECK (role IN ('student', 'facilitator', 'admin', 'owner')),
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  last_access_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_unique ON app_users (lower(email));
CREATE INDEX IF NOT EXISTS app_users_role_created_idx ON app_users (role, created_at DESC);

CREATE TABLE IF NOT EXISTS app_sessions (
  token_hash CHAR(64) PRIMARY KEY NOT NULL,
  user_id VARCHAR(100) NOT NULL REFERENCES app_users (id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  ip_hash CHAR(64),
  user_agent_hash CHAR(64)
);

CREATE INDEX IF NOT EXISTS app_sessions_user_idx ON app_sessions (user_id, expires_at);

CREATE TABLE IF NOT EXISTS app_checkouts (
  id VARCHAR(100) PRIMARY KEY NOT NULL,
  user_id VARCHAR(100) NOT NULL REFERENCES app_users (id) ON DELETE RESTRICT,
  course_id VARCHAR(100) NOT NULL REFERENCES courses (id) ON DELETE RESTRICT,
  status TEXT NOT NULL,
  currency CHAR(3) NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
  payment_method TEXT NOT NULL,
  coupon_code TEXT,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS app_checkouts_user_idx ON app_checkouts (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app_enrollments (
  id VARCHAR(100) PRIMARY KEY NOT NULL,
  user_id VARCHAR(100) NOT NULL REFERENCES app_users (id) ON DELETE RESTRICT,
  course_id VARCHAR(100) NOT NULL REFERENCES courses (id) ON DELETE RESTRICT,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  checkout_id VARCHAR(100) REFERENCES app_checkouts (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, course_id)
);

CREATE INDEX IF NOT EXISTS app_enrollments_user_idx ON app_enrollments (user_id, status);
CREATE INDEX IF NOT EXISTS app_enrollments_course_idx ON app_enrollments (course_id, status);

CREATE TABLE IF NOT EXISTS app_progress (
  user_id VARCHAR(100) NOT NULL REFERENCES app_users (id) ON DELETE CASCADE,
  course_id VARCHAR(100) NOT NULL REFERENCES courses (id) ON DELETE RESTRICT,
  snapshot_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, course_id)
);

CREATE INDEX IF NOT EXISTS app_progress_course_idx ON app_progress (course_id, updated_at DESC);
