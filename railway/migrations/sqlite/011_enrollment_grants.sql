CREATE TABLE IF NOT EXISTS app_enrollment_grants (
  id TEXT PRIMARY KEY NOT NULL,
  grant_key TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES app_users (id) ON DELETE CASCADE,
  course_id TEXT NOT NULL REFERENCES courses (id) ON DELETE RESTRICT,
  source TEXT NOT NULL,
  checkout_id TEXT REFERENCES app_checkouts (id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  suspension_reason TEXT,
  suspended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS app_enrollment_grants_user_course_status_idx
  ON app_enrollment_grants (user_id, course_id, status);

CREATE INDEX IF NOT EXISTS app_enrollment_grants_checkout_idx
  ON app_enrollment_grants (checkout_id)
  WHERE checkout_id IS NOT NULL;

-- Existing rows become an explicit historical grant before payment revocation
-- starts using this table. The original enrollment row remains untouched.
INSERT INTO app_enrollment_grants (
  id, grant_key, user_id, course_id, source, checkout_id, status,
  suspension_reason, suspended_at, created_at, updated_at
)
SELECT
  'grant-migrated-' || e.id,
  CASE
    WHEN e.checkout_id IS NOT NULL THEN 'checkout:' || e.checkout_id
    ELSE 'source:' || lower(e.source) || ':' || e.user_id || ':' || e.course_id
  END,
  e.user_id,
  e.course_id,
  lower(e.source),
  e.checkout_id,
  CASE WHEN e.status = 'active' THEN 'active' ELSE 'suspended' END,
  CASE WHEN e.status = 'active' THEN NULL ELSE 'legacy_enrollment_status' END,
  CASE WHEN e.status = 'active' THEN NULL ELSE e.updated_at END,
  e.created_at,
  e.updated_at
FROM app_enrollments e
WHERE 1
ON CONFLICT (grant_key) DO NOTHING;

UPDATE app_meta
SET value = '12', updated_at = CURRENT_TIMESTAMP
WHERE key = 'schema_version';
