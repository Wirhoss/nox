ALTER TABLE `deliberation` ADD `consensusReached` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `deliberation` ADD `terminationReason` text;