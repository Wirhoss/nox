import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import { artifactBlobs } from './artifactBlobs';

import type { RepresentationProfile } from '../../artifact/representation';

/** Regenerable deterministic representation of immutable source bytes. */
const artifactRenditions = sqliteTable(
  'artifact_renditions',
  {
    renditionId: text('rendition_id').primaryKey(),
    blobHash: text('blob_hash')
      .notNull()
      .references(() => artifactBlobs.blobHash),
    createdAt: integer('created_at').notNull(),
    declaredMediaType: text('declared_media_type'),
    detectedMediaType: text('detected_media_type'),
    mediaType: text('media_type').notNull(),
    processorId: text('processor_id').notNull(),
    processorVersion: text('processor_version').notNull(),
    profile: text('profile', { mode: 'json' }).$type<RepresentationProfile>().notNull(),
    profileDigest: text('profile_digest').notNull(),
    profileId: text('profile_id').notNull(),
    profileVersion: integer('profile_version').notNull(),
    sourceBlobHash: text('source_blob_hash')
      .notNull()
      .references(() => artifactBlobs.blobHash),
    sourceMediaType: text('source_media_type').notNull(),
  },
  (table) => [
    uniqueIndex('artifact_renditions_cache_unique').on(
      table.sourceBlobHash,
      table.sourceMediaType,
      table.profileDigest,
      table.processorId,
      table.processorVersion,
    ),
    index('artifact_renditions_blob_idx').on(table.blobHash),
    index('artifact_renditions_profile_idx').on(table.profileId, table.profileVersion),
    index('artifact_renditions_source_blob_idx').on(table.sourceBlobHash),
  ],
);

type ArtifactRenditionRow = typeof artifactRenditions.$inferSelect;
type ArtifactRenditionRowInsert = typeof artifactRenditions.$inferInsert;

export { artifactRenditions };

export type { ArtifactRenditionRow, ArtifactRenditionRowInsert };
