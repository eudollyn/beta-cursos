ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS date_of_birth DATE;

UPDATE app_meta
SET value = '9', updated_at = now()
WHERE key = 'schema_version';
