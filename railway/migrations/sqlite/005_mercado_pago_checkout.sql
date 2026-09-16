ALTER TABLE app_checkouts
  ADD COLUMN provider TEXT NOT NULL DEFAULT 'legacy_test';

ALTER TABLE app_checkouts
  ADD COLUMN provider_mode TEXT NOT NULL DEFAULT 'test';

ALTER TABLE app_checkouts
  ADD COLUMN provider_preference_id TEXT;

ALTER TABLE app_checkouts
  ADD COLUMN provider_payment_id TEXT;

ALTER TABLE app_checkouts
  ADD COLUMN provider_checkout_url TEXT;

ALTER TABLE app_checkouts
  ADD COLUMN last_provider_sync_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS app_checkouts_provider_preference_unique
  ON app_checkouts (provider_preference_id)
  WHERE provider_preference_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS app_checkouts_provider_payment_unique
  ON app_checkouts (provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

UPDATE app_meta
SET value = '8', updated_at = CURRENT_TIMESTAMP
WHERE key = 'schema_version';