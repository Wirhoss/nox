import { z } from 'zod';

import { databaseConfigSchema } from '../database/config';
import { LOG_LEVELS } from '../logger/logger';

const appConfigSchema = z.object({
  database: databaseConfigSchema.prefault({}),
  logLevel: z.enum(LOG_LEVELS).default('info'),
});

type AppConfig = z.infer<typeof appConfigSchema>;

export { appConfigSchema };

export type { AppConfig };
