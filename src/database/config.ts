import { z } from 'zod';

const sqliteConfigSchema = z.object({
  busyTimeoutMs: z.number().int().min(0).default(5_000)
    .describe(
      'How long SQLite waits on a locked database before raising SQLITE_BUSY. Writes are already '
      + 'serialized in-process, so this only matters when another process holds the lock.',
    ),
  enableWAL: z.boolean().default(true)
    .describe('Write-ahead logging: readers stop blocking on the single writer.'),
  foreignKeys: z.boolean().default(true)
    .describe('Enforce foreign key constraints. SQLite leaves these off unless asked.'),
  statementCacheSize: z.number().int().min(0).default(100)
    .describe('Number of prepared statements kept cached per connection.'),
}).prefault({});

const databaseConfigSchema = z.object({
  driver: z.enum(['sqlite']).default('sqlite')
    .describe('Which database backend to open. Only sqlite exists today.'),
  sqlite: sqliteConfigSchema
    .describe('Options for the sqlite driver; ignored by other drivers.'),
}).prefault({});

type DatabaseConfig = z.infer<typeof databaseConfigSchema>;
type DatabaseDriverName = DatabaseConfig['driver'];

export {
  databaseConfigSchema,
};

export type {
  DatabaseConfig,
  DatabaseDriverName,
};
