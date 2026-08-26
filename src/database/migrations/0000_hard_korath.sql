CREATE TABLE `accounts` (
	`account_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`password_hash` text NOT NULL,
	`updated_at` integer NOT NULL,
	`username` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_username_unique` ON `accounts` (`username`);--> statement-breakpoint
CREATE TABLE `artifact_blobs` (
	`blob_hash` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`size` integer NOT NULL,
	`storage_key` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_blobs_storage_key_unique` ON `artifact_blobs` (`storage_key`);--> statement-breakpoint
CREATE TABLE `artifact_renditions` (
	`rendition_id` text PRIMARY KEY NOT NULL,
	`blob_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`declared_media_type` text,
	`detected_media_type` text,
	`media_type` text NOT NULL,
	`processor_id` text NOT NULL,
	`processor_version` text NOT NULL,
	`profile` text NOT NULL,
	`profile_digest` text NOT NULL,
	`profile_id` text NOT NULL,
	`profile_version` integer NOT NULL,
	`source_blob_hash` text NOT NULL,
	`source_media_type` text NOT NULL,
	FOREIGN KEY (`blob_hash`) REFERENCES `artifact_blobs`(`blob_hash`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_blob_hash`) REFERENCES `artifact_blobs`(`blob_hash`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_renditions_cache_unique` ON `artifact_renditions` (`source_blob_hash`,`source_media_type`,`profile_digest`,`processor_id`,`processor_version`);--> statement-breakpoint
CREATE INDEX `artifact_renditions_blob_idx` ON `artifact_renditions` (`blob_hash`);--> statement-breakpoint
CREATE INDEX `artifact_renditions_profile_idx` ON `artifact_renditions` (`profile_id`,`profile_version`);--> statement-breakpoint
CREATE INDEX `artifact_renditions_source_blob_idx` ON `artifact_renditions` (`source_blob_hash`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`artifact_id` text PRIMARY KEY NOT NULL,
	`blob_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`declared_media_type` text,
	`detected_media_type` text,
	`filename` text,
	`media_type` text NOT NULL,
	`provenance` text NOT NULL,
	`scope_id` text NOT NULL,
	`scope_type` text NOT NULL,
	FOREIGN KEY (`blob_hash`) REFERENCES `artifact_blobs`(`blob_hash`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `artifacts_blob_idx` ON `artifacts` (`blob_hash`);--> statement-breakpoint
CREATE INDEX `artifacts_scope_idx` ON `artifacts` (`scope_type`,`scope_id`);--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`account_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	`refresh_token_hash` text NOT NULL,
	`revoked_at` integer,
	`session_id` text PRIMARY KEY NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`account_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_sessions_refresh_token_hash_unique` ON `auth_sessions` (`refresh_token_hash`);--> statement-breakpoint
CREATE INDEX `auth_sessions_account_idx` ON `auth_sessions` (`account_id`);--> statement-breakpoint
CREATE INDEX `auth_sessions_expires_idx` ON `auth_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`agent_id` text NOT NULL,
	`broker_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`session_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`broker_id`, `conversation_id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversations_session_idx` ON `conversations` (`session_id`);--> statement-breakpoint
CREATE TABLE `cron_jobs` (
	`agent_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_from_session_id` text,
	`delivery_broker_id` text,
	`delivery_channel_id` text,
	`enabled` integer NOT NULL,
	`expression` text,
	`job_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`last_error` text,
	`last_run_at` integer,
	`last_run_id` text,
	`last_status` text,
	`name` text NOT NULL,
	`next_run_at` integer,
	`one_shot_at` integer,
	`prompt` text NOT NULL,
	`time_zone` text,
	`tool_set_id` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cron_jobs_due_idx` ON `cron_jobs` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `cron_jobs_scope_idx` ON `cron_jobs` (`tool_set_id`);--> statement-breakpoint
CREATE TABLE `cron_runs` (
	`agent_id` text NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	`delivery_error` text,
	`error` text,
	`job_id` text NOT NULL,
	`output` text,
	`run_id` text PRIMARY KEY NOT NULL,
	`scheduled_for` integer NOT NULL,
	`session_id` text,
	`started_at` integer,
	`status` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `cron_jobs`(`job_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cron_runs_job_idx` ON `cron_runs` (`job_id`,`scheduled_for`);--> statement-breakpoint
CREATE INDEX `cron_runs_status_idx` ON `cron_runs` (`status`);--> statement-breakpoint
CREATE TABLE `decisions` (
	`authority` text NOT NULL,
	`created_at` integer NOT NULL,
	`decided_by` text NOT NULL,
	`decision_id` text PRIMARY KEY NOT NULL,
	`matched_grant` text,
	`params` text NOT NULL,
	`preview` text,
	`principal_issuer` text NOT NULL,
	`principal_subject` text NOT NULL,
	`reason` text NOT NULL,
	`resolution` text,
	`resolved_at` integer,
	`resolved_by_issuer` text,
	`resolved_by_subject` text,
	`risk` text,
	`run_id` text NOT NULL,
	`scope` text,
	`session_id` text NOT NULL,
	`signals` text,
	`stage` text NOT NULL,
	`title` text,
	`tool_name` text NOT NULL,
	`tool_set_id` text NOT NULL,
	`track_id` text NOT NULL,
	`verdict` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `decisions_session_created_idx` ON `decisions` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `decisions_track_idx` ON `decisions` (`session_id`,`track_id`);--> statement-breakpoint
CREATE INDEX `decisions_principal_idx` ON `decisions` (`principal_issuer`,`principal_subject`);--> statement-breakpoint
CREATE TABLE `messages` (
	`anchor_message_id` text,
	`arguments` text,
	`content` text,
	`created_at` integer NOT NULL,
	`delivery` text,
	`execution` text,
	`is_error` integer,
	`message_id` text PRIMARY KEY NOT NULL,
	`name` text,
	`principal_issuer` text,
	`principal_subject` text,
	`ref_message_ids` text,
	`role` text NOT NULL,
	`seq` integer NOT NULL,
	`session_id` text NOT NULL,
	`track_id` text,
	`transport_message_id` text,
	`trust` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_session_seq_idx` ON `messages` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `messages_track_idx` ON `messages` (`session_id`,`track_id`);--> statement-breakpoint
CREATE TABLE `secrets` (
	`auth_tag` text NOT NULL,
	`ciphertext` text NOT NULL,
	`created_at` integer NOT NULL,
	`nonce` text NOT NULL,
	`secret_id` text PRIMARY KEY NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`agent_id` text,
	`created_at` integer NOT NULL,
	`metadata` text,
	`session_id` text PRIMARY KEY NOT NULL,
	`title` text,
	`updated_at` integer NOT NULL
);
