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

/**
 * The zone this installation reads clocks in.
 *
 * It is not a display preference: an agent that does not know what day it is
 * where its operator lives answers "tomorrow" about the wrong day, and every
 * timestamp it is shown is a date it can get wrong. UTC is the default because
 * it is never ambiguous, not because it is usually right.
 *
 * Validated against the runtime's own zone database rather than a list kept
 * here: a typo is a configuration error worth catching at load, and the set of
 * real zones is not ours to enumerate.
 */
const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Use an IANA time zone name, such as UTC or America/Mexico_City.')
  .default('UTC');

const appConfigSchema = z.object({
  api: apiConfigSchema.prefault({}),
  auth: authConfigSchema.prefault({}),
  chat: chatConfigSchema.prefault({}),
  database: databaseConfigSchema.prefault({}),
  logLevel: z.enum(LOG_LEVELS).default('info'),
  timezone: timezoneSchema,
  ui: uiConfigSchema.prefault({}),
});

type AppConfig = z.infer<typeof appConfigSchema>;

export { appConfigSchema };

export type { AppConfig };
