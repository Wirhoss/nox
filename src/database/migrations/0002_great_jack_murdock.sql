CREATE TABLE `accounts` (
	`account_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`password_hash` text NOT NULL,
	`updated_at` integer NOT NULL,
	`username` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_username_unique` ON `accounts` (`username`);--> statement-breakpoint
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
CREATE INDEX `auth_sessions_expires_idx` ON `auth_sessions` (`expires_at`);