CREATE TABLE `artifact_blobs` (
	`blob_hash` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`size` integer NOT NULL,
	`storage_key` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_blobs_storage_key_unique` ON `artifact_blobs` (`storage_key`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`artifact_id` text PRIMARY KEY NOT NULL,
	`blob_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`declared_media_type` text,
	`detected_media_type` text,
	`filename` text,
	`media_type` text NOT NULL,
	`provenance` text NOT NULL,
	`scope_id` text NOT NULL,
	`scope_type` text NOT NULL,
	FOREIGN KEY (`blob_hash`) REFERENCES `artifact_blobs`(`blob_hash`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `artifacts_blob_idx` ON `artifacts` (`blob_hash`);--> statement-breakpoint
CREATE INDEX `artifacts_scope_idx` ON `artifacts` (`scope_type`,`scope_id`);