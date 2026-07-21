import { Elysia } from 'elysia';
import { z } from 'zod';

import { Config } from '../../config';
import {
  createDeliberationSchema,
  deliberationConfigurationSchema,
  DeliberationRegistry,
} from '../../deliberation';

import { deliberationParamsSchema } from './shared';

function registry(): DeliberationRegistry {
  const instance = DeliberationRegistry.instance;
  if (!instance.initialized) instance.init(Config.get('env').databaseFile);
  return instance;
}

const deliberationRoutes = new Elysia({ prefix: '/api/v1' })
  .get('/deliberations', ({ query }) => registry().list(query.q), {
    query: z.object({ q: z.string().trim().min(1).optional() }),
  })
  .get('/deliberations/:deliberationId', ({ params }) => registry().getDetail(params.deliberationId), {
    params: deliberationParamsSchema,
  })
  .post('/deliberations', ({ body, status }) => status(201, registry().create(body)), {
    body: createDeliberationSchema,
  })
  .put('/deliberations/:deliberationId', ({ body, params }) => registry().configure(params.deliberationId, body), {
    body: deliberationConfigurationSchema,
    params: deliberationParamsSchema,
  })
  .post('/deliberations/:deliberationId/run', ({ params, status }) => status(202, registry().start(params.deliberationId)), {
    params: deliberationParamsSchema,
  })
  .post('/deliberations/:deliberationId/cancel', async ({ params }) => registry().cancel(params.deliberationId), {
    params: deliberationParamsSchema,
  });

export {
  deliberationRoutes,
};
