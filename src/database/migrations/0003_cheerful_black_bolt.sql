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
CREATE INDEX `conversations_session_idx` ON `conversations` (`session_id`);