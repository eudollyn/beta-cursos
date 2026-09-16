-- Fases são uma regra pastoral explícita e independente das categorias do catálogo.
ALTER TABLE app_users ADD COLUMN pastoral_phase TEXT;
ALTER TABLE app_users ADD COLUMN pastoral_phase_updated_at TEXT;
ALTER TABLE app_users ADD COLUMN pastoral_phase_updated_by TEXT;

CREATE TABLE IF NOT EXISTS app_pastoral_course_grants (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES app_users (id) ON DELETE CASCADE,
  course_id TEXT NOT NULL REFERENCES courses (id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  reason TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_by TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS app_pastoral_course_grants_user_course_status_idx
  ON app_pastoral_course_grants (user_id, course_id, status, expires_at);

CREATE INDEX IF NOT EXISTS app_users_pastoral_phase_idx
  ON app_users (pastoral_phase, role, account_status);

UPDATE app_meta SET value = '13', updated_at = CURRENT_TIMESTAMP
WHERE key = 'schema_version';
