ALTER TABLE app_users
  ADD COLUMN account_status TEXT NOT NULL DEFAULT 'active'
  CHECK (account_status IN ('active', 'disabled'));

ALTER TABLE app_users ADD COLUMN disabled_at TEXT;
ALTER TABLE app_users ADD COLUMN disabled_by TEXT;

CREATE INDEX IF NOT EXISTS app_users_account_status_idx
  ON app_users (role, account_status, created_at DESC);
