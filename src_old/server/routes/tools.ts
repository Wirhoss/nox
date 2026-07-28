import { Elysia } from 'elysia';

import { ToolRegistry } from '../../tool/registry';

const toolRoutes = new Elysia({ prefix: '/api/v1' })
  .get('/tools', () => ToolRegistry.instance.listToolSetIds());

export {
  toolRoutes,
};
