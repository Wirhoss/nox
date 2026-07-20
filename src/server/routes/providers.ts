import { Elysia } from 'elysia';
import { z } from 'zod';

import { Config } from '../../config';
import {
  deleteProviderConfig,
  providerConfigSchema,
  providerIdSchema,
  upsertProviderConfig,
} from '../../config/provider';
import { ProviderRegistry } from '../../provider';

import type { ProviderConfig } from '../../config/provider';

type ProviderConfigView = Omit<ProviderConfig, 'apiKey'> & { hasApiKey: boolean };

function redactProviderConfig(config: ProviderConfig): ProviderConfigView {
  const { apiKey, ...rest } = config;
  return { ...rest, hasApiKey: apiKey !== undefined && apiKey !== '' };
}

const providerRoutes = new Elysia({ prefix: '/api/v1' })
  .get('/providers', () => {
    const providers = Config.get('providers');
    return Object.fromEntries(
      Object.entries(providers).map(([id, config]) => [id, redactProviderConfig(config)])
    );
  })
  .get('/providers/:id', ({ params, status }) => {
    const config = Config.get('providers')[params.id];
    if (!config) {
      return status(404, { message: `Provider with id ${params.id} not found.` });
    }
    return redactProviderConfig(config);
  }, {
    params: z.object({ id: providerIdSchema }),
  })
  .get('/providers/:id/models', ({ params, status }) => {
    const provider = ProviderRegistry.instance.getProvider(params.id);
    if (provider) {
      return provider.listModelConfigs();
    }
    // Configured but not live: dropped as unreachable at startup, or added
    // since the last restart (provider changes only apply on restart).
    if (Config.get('providers')[params.id]) {
      return status(503, { message: `Provider with id ${params.id} is configured but not active; a restart may be required.` });
    }
    return status(404, { message: `Provider with id ${params.id} not found.` });
  }, {
    params: z.object({ id: providerIdSchema }),
  })
  .post('/providers', async ({ body, status }) => {
    if (Config.get('providers')[body.id]) {
      return status(409, { message: `Provider with id ${body.id} already exists.` });
    }
    try {
      const saved = await upsertProviderConfig(Config.get('env'), body.id, body.config);
      return status(201, { provider: redactProviderConfig(saved), restartRequired: true });
    } catch (error) {
      return status(500, { message: (error as Error).message });
    }
  }, {
    body: z.object({
      id: providerIdSchema,
      config: providerConfigSchema,
    }),
  })
  .put('/providers/:id', async ({ params, body, status }) => {
    if (!Config.get('providers')[params.id]) {
      return status(404, { message: `Provider with id ${params.id} not found.` });
    }
    try {
      const saved = await upsertProviderConfig(Config.get('env'), params.id, body);
      return status(200, { provider: redactProviderConfig(saved), restartRequired: true });
    } catch (error) {
      return status(500, { message: (error as Error).message });
    }
  }, {
    params: z.object({ id: providerIdSchema }),
    body: providerConfigSchema,
  })
  .delete('/providers/:id', async ({ params, status }) => {
    const providers = Config.get('providers');
    if (!providers[params.id]) {
      return status(404, { message: `Provider with id ${params.id} not found.` });
    }
    if (Object.keys(providers).length <= 1) {
      return status(409, { message: 'At least one provider must remain configured.' });
    }
    try {
      await deleteProviderConfig(Config.get('env'), params.id);
      return status(200, { restartRequired: true });
    } catch (error) {
      return status(500, { message: (error as Error).message });
    }
  }, {
    params: z.object({ id: providerIdSchema }),
  });

export {
  providerRoutes,
};
