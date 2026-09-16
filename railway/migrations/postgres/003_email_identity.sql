ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

-- Contas criadas antes desta migration continuam acessíveis. Novos cadastros
-- só são materializados depois da confirmação do endereço de e-mail.
UPDATE app_users
SET email_verified_at = COALESCE(email_verified_at, created_at);

CREATE TABLE IF NOT EXISTS app_auth_tokens (
  token_hash CHAR(64) PRIMARY KEY NOT NULL,
  purpose TEXT NOT NULL
    CHECK (purpose IN ('complete_registration', 'reset_password')),
  email TEXT NOT NULL,
  user_id VARCHAR(100) REFERENCES app_users (id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  requested_ip_hash CHAR(64),
  user_agent_hash CHAR(64)
);

CREATE INDEX IF NOT EXISTS app_auth_tokens_email_purpose_idx
  ON app_auth_tokens (lower(email), purpose, expires_at DESC);

CREATE INDEX IF NOT EXISTS app_auth_tokens_user_purpose_idx
  ON app_auth_tokens (user_id, purpose, expires_at DESC);

CREATE INDEX IF NOT EXISTS app_auth_tokens_expiry_idx
  ON app_auth_tokens (expires_at);

UPDATE app_meta
SET value = '6', updated_at = now()
WHERE key = 'schema_version';
