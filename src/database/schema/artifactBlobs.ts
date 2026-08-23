import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Immutable bytes addressed by their SHA-256 digest. */
const artifactBlobs = sqliteTable(
  'artifact_blobs',
  {
    blobHash: text('blob_hash').primaryKey(),
    createdAt: integer('created_at').notNull(),
    size: integer('size').notNull(),
    storageKey: text('storage_key').notNull(),
  },
  (table) => [uniqueIndex('artifact_blobs_storage_key_unique').on(table.storageKey)],
);

type ArtifactBlobRow = typeof artifactBlobs.$inferSelect;
type ArtifactBlobRowInsert = typeof artifactBlobs.$inferInsert;

export { artifactBlobs };

export type { ArtifactBlobRow, ArtifactBlobRowInsert };
