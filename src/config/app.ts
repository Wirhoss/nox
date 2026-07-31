import { z } from 'zod';

import { databaseConfigSchema } from '../database/config';

const appConfigSchema = z.object({
  database: databaseConfigSchema,
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  server: z.object({
    host: z.string().min(1).default('127.0.0.1'),
    port: z.number().int().min(1).max(65_535).default(3000),
  }).prefault({}),
});

type AppConfig = z.infer<typeof appConfigSchema>;

export {
  appConfigSchema,
};

export type {
  AppConfig,
};
