CREATE TABLE `run` (
	`runId` text PRIMARY KEY,
	`sessionId` text NOT NULL,
	`modelId` text,
	`status` text NOT NULL,
	`startedAt` integer NOT NULL,
	`completedAt` integer,
	`durationMs` integer,
	`inputTokens` integer DEFAULT 0 NOT NULL,
	`outputTokens` integer DEFAULT 0 NOT NULL,
	`cacheReadTokens` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_run_sessionId_session_sessionId_fk` FOREIGN KEY (`sessionId`) REFERENCES `session`(`sessionId`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `session_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`sessionId` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `fk_session_event_sessionId_session_sessionId_fk` FOREIGN KEY (`sessionId`) REFERENCES `session`(`sessionId`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `run_session_started_idx` ON `run` (`sessionId`,`startedAt`);--> statement-breakpoint
CREATE INDEX `session_event_session_id_idx` ON `session_event` (`sessionId`,`id`);