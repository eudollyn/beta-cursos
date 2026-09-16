PRAGMA foreign_keys = ON;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `admins` (
  `email` text PRIMARY KEY NOT NULL,
  `full_name` text NOT NULL,
  `role` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `created_by` text NOT NULL,
  CONSTRAINT `admins_role_check` CHECK (`role` IN ('owner', 'admin'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `courses` (
  `id` text PRIMARY KEY NOT NULL,
  `slug` text NOT NULL,
  `title` text NOT NULL,
  `status` text NOT NULL,
  `data_json` text NOT NULL,
  `version` integer DEFAULT 1 NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `published_at` text,
  `created_by` text NOT NULL,
  `updated_by` text NOT NULL,
  CONSTRAINT `courses_status_check` CHECK (`status` IN ('draft', 'published', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `courses_slug_unique` ON `courses` (`slug`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `courses_status_updated_idx` ON `courses` (`status`, `updated_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `media` (
  `id` text PRIMARY KEY NOT NULL,
  `storage_key` text NOT NULL,
  `filename` text NOT NULL,
  `content_type` text NOT NULL,
  `kind` text NOT NULL,
  `size` integer NOT NULL,
  `sha256` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `created_by` text NOT NULL,
  CONSTRAINT `media_kind_check` CHECK (`kind` IN ('pdf', 'video', 'image')),
  CONSTRAINT `media_size_check` CHECK (`size` > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `media_storage_key_unique` ON `media` (`storage_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `media_kind_created_idx` ON `media` (`kind`, `created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `audit_log` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `actor_email` text NOT NULL,
  `action` text NOT NULL,
  `entity_type` text NOT NULL,
  `entity_id` text,
  `details_json` text DEFAULT '{}' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_log_created_idx` ON `audit_log` (`created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `app_meta` (
  `key` text PRIMARY KEY NOT NULL,
  `value` text NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
INSERT INTO `app_meta` (`key`, `value`, `updated_at`)
VALUES ('schema_version', '2', CURRENT_TIMESTAMP)
ON CONFLICT (`key`) DO UPDATE SET `value` = excluded.`value`, `updated_at` = excluded.`updated_at`;
