import { index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** JSON documents durably owned by one extension and grouped into collections. */
const extensionState = sqliteTable(
  'extension_state',
  {
    collection: text('collection').notNull(),
    extensionId: text('extension_id').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.extensionId, table.collection, table.key] }),
    index('extension_state_collection_idx').on(table.extensionId, table.collection),
  ],
);

type ExtensionStateRow = typeof extensionState.$inferSelect;
type ExtensionStateRowInsert = typeof extensionState.$inferInsert;

export { extensionState };

export type { ExtensionStateRow, ExtensionStateRowInsert };
