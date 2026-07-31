import { z } from 'zod';

const appConfigSchema = z.object({
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
