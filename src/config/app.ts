import { z } from 'zod';

import { authConfigSchema } from '../api/auth/config';
import { apiConfigSchema } from '../api/config';
import { databaseConfigSchema } from '../database/config';
import { LOG_LEVELS } from '../logger/logger';

const chatConfigSchema = z.object({
  /**
   * A single-agent installation needs no choice. A multi-agent installation
   * names what a new web conversation uses until the surface offers a picker.
   */
  defaultAgent: z.string().trim().min(1).optional(),
});

const appConfigSchema = z.object({
  api: apiConfigSchema.prefault({}),
  auth: authConfigSchema.prefault({}),
  chat: chatConfigSchema.prefault({}),
  database: databaseConfigSchema.prefault({}),
  logLevel: z.enum(LOG_LEVELS).default('info'),
});

type AppConfig = z.infer<typeof appConfigSchema>;

export { appConfigSchema };

export type { AppConfig };
