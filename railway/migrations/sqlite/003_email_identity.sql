ALTER TABLE app_users ADD COLUMN email_verified_at TEXT;

-- Contas criadas antes desta migration continuam acessíveis. Novos cadastros
-- só são materializados depois da confirmação do endereço de e-mail.
UPDATE app_users
SET email_verified_at = COALESCE(email_verified_at, created_at);

CREATE TABLE IF NOT EXISTS app_auth_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  purpose TEXT NOT NULL
    CHECK (purpose IN ('complete_registration', 'reset_password')),
  email TEXT NOT NULL,
  user_id TEXT REFERENCES app_users (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  requested_ip_hash TEXT,
  user_agent_hash TEXT
);

CREATE INDEX IF NOT EXISTS app_auth_tokens_email_purpose_idx
  ON app_auth_tokens (email, purpose, expires_at DESC);

CREATE INDEX IF NOT EXISTS app_auth_tokens_user_purpose_idx
  ON app_auth_tokens (user_id, purpose, expires_at DESC);

CREATE INDEX IF NOT EXISTS app_auth_tokens_expiry_idx
  ON app_auth_tokens (expires_at);

UPDATE app_meta
SET value = '6', updated_at = CURRENT_TIMESTAMP
WHERE key = 'schema_version';
