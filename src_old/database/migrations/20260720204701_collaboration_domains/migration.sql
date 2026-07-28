CREATE TABLE IF NOT EXISTS `deep_research` (
	`researchId` text PRIMARY KEY,
	`title` text NOT NULL,
	`objective` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `deliberation` (
	`deliberationId` text PRIMARY KEY,
	`title` text NOT NULL,
	`question` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`createdAt` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `deep_research_status_updated_idx` ON `deep_research` (`status`,`updatedAt`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `deliberation_status_updated_idx` ON `deliberation` (`status`,`updatedAt`);
