CREATE TABLE `message` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`sessionId` text NOT NULL,
	`position` integer NOT NULL,
	`role` text NOT NULL,
	`payload` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_message_sessionId_session_sessionId_fk` FOREIGN KEY (`sessionId`) REFERENCES `session`(`sessionId`) ON DELETE CASCADE,
	CONSTRAINT `message_sessionId_position_unique` UNIQUE(`sessionId`,`position`)
);
--> statement-breakpoint
CREATE TABLE `session` (
	`sessionId` text PRIMARY KEY,
	`blueprintId` text NOT NULL,
	`systemPrompt` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL
);
