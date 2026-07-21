CREATE TABLE `deliberation_turn` (
	`turnId` integer PRIMARY KEY AUTOINCREMENT,
	`deliberationId` text NOT NULL,
	`round` integer NOT NULL,
	`phase` text NOT NULL,
	`blueprintId` text NOT NULL,
	`sessionId` text NOT NULL,
	`content` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `fk_deliberation_turn_deliberationId_deliberation_deliberationId_fk` FOREIGN KEY (`deliberationId`) REFERENCES `deliberation`(`deliberationId`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `deliberation` ADD `participantBlueprintIds` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `deliberation` ADD `moderatorBlueprintId` text;--> statement-breakpoint
ALTER TABLE `deliberation` ADD `rounds` integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE `deliberation` ADD `currentRound` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `deliberation` ADD `finalReport` text;--> statement-breakpoint
ALTER TABLE `deliberation` ADD `error` text;--> statement-breakpoint
ALTER TABLE `deliberation` ADD `startedAt` integer;--> statement-breakpoint
ALTER TABLE `deliberation` ADD `completedAt` integer;--> statement-breakpoint
CREATE INDEX `deliberation_turn_deliberation_idx` ON `deliberation_turn` (`deliberationId`,`turnId`);