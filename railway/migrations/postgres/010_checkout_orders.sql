ALTER TABLE app_checkouts
  ADD COLUMN IF NOT EXISTS provider_order_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS app_checkouts_provider_order_unique
  ON app_checkouts (provider_order_id)
  WHERE provider_order_id IS NOT NULL;

UPDATE app_meta
SET value = '11', updated_at = now()
WHERE key = 'schema_version';
