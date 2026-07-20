import { Elysia } from 'elysia';

import { blueprintRoutes } from './blueprints';
import { configRoutes } from './config';
import { healthRoutes } from './health';
import { providerRoutes } from './providers';
import { sessionRoutes } from './sessions';
import { toolRoutes } from './tools';

const routes = new Elysia()
  .use(healthRoutes)
  .use(sessionRoutes)
  .use(providerRoutes)
  .use(blueprintRoutes)
  .use(configRoutes)
  .use(toolRoutes);

export {
  routes,
};
