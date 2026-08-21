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
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_session_seq_idx` ON `messages` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `messages_track_idx` ON `messages` (`session_id`,`track_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`agent_id` text,
	`created_at` integer NOT NULL,
	`metadata` text,
	`session_id` text PRIMARY KEY NOT NULL,
	`title` text,
	`updated_at` integer NOT NULL
);
