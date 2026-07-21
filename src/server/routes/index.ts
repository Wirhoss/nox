import { Elysia } from 'elysia';

import { blueprintRoutes } from './blueprints';
import { configRoutes } from './config';
import { deepResearchRoutes } from './deepResearch';
import { deliberationRoutes } from './deliberations';
import { healthRoutes } from './health';
import { logRoutes } from './logs';
import { providerRoutes } from './providers';
import { runRoutes } from './runs';
import { sessionRoutes } from './sessions';
import { toolRoutes } from './tools';

const routes = new Elysia()
  .use(healthRoutes)
  .use(logRoutes)
  .use(runRoutes)
  .use(sessionRoutes)
  .use(providerRoutes)
  .use(blueprintRoutes)
  .use(configRoutes)
  .use(toolRoutes)
  .use(deepResearchRoutes)
  .use(deliberationRoutes);

export {
  routes,
};
