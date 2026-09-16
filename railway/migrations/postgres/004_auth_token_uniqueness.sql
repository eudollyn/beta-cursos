-- Mantém somente o token ativo mais recente antes de instalar a restrição.
-- O descarte é seguro: tokens de autenticação são temporários e podem ser
-- solicitados novamente sem alterar a conta do usuário.
WITH ranked_active_tokens AS (
  SELECT
    token_hash,
    ROW_NUMBER() OVER (
      PARTITION BY lower(email), purpose
      ORDER BY created_at DESC, token_hash DESC
    ) AS duplicate_rank
  FROM app_auth_tokens
  WHERE consumed_at IS NULL
)
DELETE FROM app_auth_tokens AS token
USING ranked_active_tokens AS ranked
WHERE token.token_hash = ranked.token_hash
  AND ranked.duplicate_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS app_auth_tokens_active_email_purpose_idx
  ON app_auth_tokens (lower(email), purpose)
  WHERE consumed_at IS NULL;

UPDATE app_meta
SET value = '7', updated_at = now()
WHERE key = 'schema_version';
