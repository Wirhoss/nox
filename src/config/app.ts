import { z } from 'zod';

import { authConfigSchema } from '../api/auth/config';
import { apiConfigSchema } from '../api/serverConfig';
import { databaseConfigSchema } from '../database/config';
import { localeSchema } from '../i18n/locale';
import { LOG_LEVELS } from '../logger/logger';

const chatConfigSchema = z.object({
  /**
   * A single-agent installation needs no choice. A multi-agent installation
   * names what a new web conversation uses until the surface offers a picker.
   */
  defaultAgent: z.string().trim().min(1).optional(),
});

const uiConfigSchema = z.object({
  /** Installation default; a browser may keep its own public access-screen choice. */
  locale: localeSchema.default('en'),
});

const appConfigSchema = z.object({
  api: apiConfigSchema.prefault({}),
  auth: authConfigSchema.prefault({}),
  chat: chatConfigSchema.prefault({}),
  database: databaseConfigSchema.prefault({}),
  logLevel: z.enum(LOG_LEVELS).default('info'),
  ui: uiConfigSchema.prefault({}),
});

type AppConfig = z.infer<typeof appConfigSchema>;

export { appConfigSchema };

export type { AppConfig };
