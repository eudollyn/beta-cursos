ALTER TABLE app_users ADD COLUMN date_of_birth TEXT;

UPDATE app_meta
SET value = '9', updated_at = CURRENT_TIMESTAMP
WHERE key = 'schema_version';
