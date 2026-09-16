ALTER TABLE app_checkouts
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'legacy_test',
  ADD COLUMN IF NOT EXISTS provider_mode TEXT NOT NULL DEFAULT 'test',
  ADD COLUMN IF NOT EXISTS provider_preference_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_payment_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_checkout_url TEXT,
  ADD COLUMN IF NOT EXISTS last_provider_sync_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS app_checkouts_provider_preference_unique
  ON app_checkouts (provider_preference_id)
  WHERE provider_preference_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS app_checkouts_provider_payment_unique
  ON app_checkouts (provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

UPDATE app_meta
SET value = '8', updated_at = now()
WHERE key = 'schema_version';