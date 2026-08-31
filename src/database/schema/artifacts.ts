import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { ARTIFACT_SCOPE_TYPES } from '../../artifact/types';
import { artifactBlobs } from './artifactBlobs';

import type { ArtifactProvenance } from '../../artifact/types';

/** Logical identity, ownership and provenance over one immutable blob. */
const artifacts = sqliteTable(
  'artifacts',
  {
    artifactId: text('artifact_id').primaryKey(),
    blobHash: text('blob_hash')
      .notNull()
      .references(() => artifactBlobs.blobHash),
    createdAt: integer('created_at').notNull(),
    declaredMediaType: text('declared_media_type'),
    detectedMediaType: text('detected_media_type'),
    filename: text('filename'),
    mediaType: text('media_type').notNull(),
    provenance: text('provenance', { mode: 'json' }).$type<ArtifactProvenance>().notNull(),
    scopeId: text('scope_id').notNull(),
    scopeType: text('scope_type', { enum: ARTIFACT_SCOPE_TYPES }).notNull(),
  },
  (table) => [
    index('artifacts_blob_idx').on(table.blobHash),
    index('artifacts_scope_idx').on(table.scopeType, table.scopeId),
  ],
);

type ArtifactRow = typeof artifacts.$inferSelect;
type ArtifactRowInsert = typeof artifacts.$inferInsert;

export { artifacts };

export type { ArtifactRow, ArtifactRowInsert };
