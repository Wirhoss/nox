CREATE TABLE `gate_decisions` (
	`created_at` integer NOT NULL,
	`decided_by` text NOT NULL,
	`decision_id` text PRIMARY KEY NOT NULL,
	`params` text NOT NULL,
	`preview` text,
	`reason` text NOT NULL,
	`resolution` text,
	`resolved_at` integer,
	`risk` text,
	`scope` text,
	`session_id` text NOT NULL,
	`signals` text NOT NULL,
	`title` text NOT NULL,
	`tool_name` text NOT NULL,
	`tool_set_id` text NOT NULL,
	`track_id` text NOT NULL,
	`verdict` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gate_decisions_session_created_idx` ON `gate_decisions` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `gate_decisions_track_idx` ON `gate_decisions` (`session_id`,`track_id`);