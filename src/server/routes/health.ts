import { Elysia } from 'elysia';

const healthRoutes = new Elysia()
  .get('/api/health', () => ({ status: 'ok' }));

export {
  healthRoutes,
};
