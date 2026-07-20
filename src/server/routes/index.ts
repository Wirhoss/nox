import { Elysia } from 'elysia';

import { agentRoutes } from './agents';
import { configRoutes } from './config';
import { healthRoutes } from './health';
import { providerRoutes } from './providers';
import { sessionRoutes } from './sessions';
import { toolRoutes } from './tools';

const routes = new Elysia()
  .use(healthRoutes)
  .use(sessionRoutes)
  .use(providerRoutes)
  .use(agentRoutes)
  .use(configRoutes)
  .use(toolRoutes);

export {
  routes,
};
