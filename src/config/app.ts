import { ianaTimeZoneSchema, localeSchema } from '@nox/extension-api';
import { z } from 'zod';

import { authConfigSchema } from '../api/auth/config';
import { apiConfigSchema } from '../api/serverConfig';
import { artifactConfigSchema } from '../artifact/config';
import { databaseConfigSchema } from '../database/config';
import { LOG_LEVELS } from '../logger/logger';

const uiConfigSchema = z.object({
  /** Installation default; a browser may keep its own public access-screen choice. */
  locale: localeSchema.default('en'),
});

const timezoneSchema = ianaTimeZoneSchema.default('UTC');

const appConfigSchema = z.object({
  api: apiConfigSchema.prefault({}),
  artifacts: artifactConfigSchema.prefault({}),
  auth: authConfigSchema.prefault({}),
  database: databaseConfigSchema.prefault({}),
  logLevel: z.enum(LOG_LEVELS).default('info'),
  timezone: timezoneSchema,
  ui: uiConfigSchema.prefault({}),
});

type AppConfig = z.infer<typeof appConfigSchema>;

export { appConfigSchema, ianaTimeZoneSchema, timezoneSchema };

export type { AppConfig };
