import { Elysia } from 'elysia';
import { z } from 'zod';

import { AgentRegistry } from '../../agent/registry';

import { resourceIdSchema } from './shared';

const runStatusSchema = z.enum(['running', 'completed', 'aborted', 'maxIterations', 'failed']);

const runRoutes = new Elysia({ prefix: '/api/v1' })
  .get('/runs', ({ query }) => AgentRegistry.instance.listRuns(query), {
    query: z.object({
      blueprintId: resourceIdSchema.optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
      sessionId: resourceIdSchema.optional(),
      status: runStatusSchema.optional(),
    }),
  });

export {
  runRoutes,
};
