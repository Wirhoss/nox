import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit only generates and inspects migrations; nothing here runs at
 * runtime. The application applies migrations itself through `Database.open()`,
 * which reads the same `out` folder.
 */
export default defineConfig({
  dbCredentials: { url: process.env.NOX_DATABASE_PATH ?? 'nox.db' },
  dialect: 'sqlite',
  out: './src/database/migrations',
  schema: './src/database/schema/index.ts',
  strict: true,
  verbose: true,
});
