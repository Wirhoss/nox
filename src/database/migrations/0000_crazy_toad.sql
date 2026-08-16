CREATE TABLE `messages` (
	`anchor_message_id` text,
	`arguments` text,
	`content` text,
	`created_at` integer NOT NULL,
	`execution` text,
	`is_error` integer,
	`message_id` text PRIMARY KEY NOT NULL,
	`name` text,
	`ref_message_ids` text,
	`role` text NOT NULL,
	`seq` integer NOT NULL,
	`session_id` text NOT NULL,
	`track_id` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_session_seq_idx` ON `messages` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `messages_track_idx` ON `messages` (`session_id`,`track_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`created_at` integer NOT NULL,
	`metadata` text,
	`session_id` text PRIMARY KEY NOT NULL,
	`title` text,
	`updated_at` integer NOT NULL
);
