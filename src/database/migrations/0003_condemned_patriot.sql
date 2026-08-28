CREATE TABLE `backfills` (
	`completed_at` integer NOT NULL,
	`name` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `message_artifacts` (
	`artifact_id` text NOT NULL,
	`message_id` text NOT NULL,
	`session_id` text NOT NULL,
	PRIMARY KEY(`message_id`, `artifact_id`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`message_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_artifacts_artifact_idx` ON `message_artifacts` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `message_artifacts_session_idx` ON `message_artifacts` (`session_id`);