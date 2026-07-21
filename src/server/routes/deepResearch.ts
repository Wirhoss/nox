import { Elysia } from 'elysia';
import { z } from 'zod';

import { Config } from '../../config';
import { createDeepResearchSchema, DeepResearchRegistry } from '../../deepResearch';

import { researchParamsSchema } from './shared';

function registry(): DeepResearchRegistry {
  const instance = DeepResearchRegistry.instance;
  if (!instance.initialized) instance.init(Config.get('env').databaseFile);
  return instance;
}

const deepResearchRoutes = new Elysia({ prefix: '/api/v1' })
  .get('/deep-research', ({ query }) => registry().list(query.q), {
    query: z.object({ q: z.string().trim().min(1).optional() }),
  })
  .get('/deep-research/:researchId', ({ params }) => registry().get(params.researchId), {
    params: researchParamsSchema,
  })
  .post('/deep-research', ({ body, status }) => status(201, registry().create(body)), {
    body: createDeepResearchSchema,
  });

export {
  deepResearchRoutes,
};
