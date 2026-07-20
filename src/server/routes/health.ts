import { Elysia } from 'elysia';

import { Config } from '../../config';
import { ProviderRegistry } from '../../provider';

const healthRoutes = new Elysia()
  .get('/api/health', () => ({ status: 'ok' }))
  .get('/api/health/live', () => ({ status: 'ok' }))
  .get('/api/health/ready', ({ status }) => {
    const configuredProviders = Object.keys(Config.get('providers')).length;
    const activeProviders = ProviderRegistry.instance.listProviderIds().length;
    const body = {
      checks: {
        providers: {
          active: activeProviders,
          configured: configuredProviders,
        },
      },
      status: activeProviders > 0 ? 'ready' : 'degraded',
    };
    return activeProviders > 0 ? body : status(503, body);
  });

export {
  healthRoutes,
};
