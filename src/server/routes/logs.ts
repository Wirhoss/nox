import { Elysia } from 'elysia';
import { z } from 'zod';

import { logStore } from '../../logger';

const logLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

const logRoutes = new Elysia({ prefix: '/api/v1' })
  .get('/logs', ({ query }) => logStore.list(query), {
    query: z.object({
      level: logLevelSchema.optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
      module: z.string().trim().min(1).max(80).optional(),
      offset: z.coerce.number().int().min(0).default(0),
      search: z.string().trim().max(200).optional(),
    }),
  });

export {
  logRoutes,
};
