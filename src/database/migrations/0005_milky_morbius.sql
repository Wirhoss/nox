CREATE TABLE `artifact_renditions` (
	`rendition_id` text PRIMARY KEY NOT NULL,
	`blob_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`declared_media_type` text,
	`detected_media_type` text,
	`media_type` text NOT NULL,
	`processor_id` text NOT NULL,
	`processor_version` text NOT NULL,
	`profile` text NOT NULL,
	`profile_digest` text NOT NULL,
	`profile_id` text NOT NULL,
	`profile_version` integer NOT NULL,
	`source_blob_hash` text NOT NULL,
	`source_media_type` text NOT NULL,
	FOREIGN KEY (`blob_hash`) REFERENCES `artifact_blobs`(`blob_hash`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_blob_hash`) REFERENCES `artifact_blobs`(`blob_hash`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_renditions_cache_unique` ON `artifact_renditions` (`source_blob_hash`,`source_media_type`,`profile_digest`,`processor_id`,`processor_version`);--> statement-breakpoint
CREATE INDEX `artifact_renditions_blob_idx` ON `artifact_renditions` (`blob_hash`);--> statement-breakpoint
CREATE INDEX `artifact_renditions_profile_idx` ON `artifact_renditions` (`profile_id`,`profile_version`);--> statement-breakpoint
CREATE INDEX `artifact_renditions_source_blob_idx` ON `artifact_renditions` (`source_blob_hash`);