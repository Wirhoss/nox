import { Elysia } from 'elysia';
import { z } from 'zod';

import { AgentRegistry } from '../../agent/registry';
import { Config } from '../../config';
import {
  deleteProviderConfig,
  providerConfigSchema,
  providerIdSchema,
  upsertProviderConfig,
} from '../../config/provider';
import { createLogger } from '../../logger';
import { ProviderRegistry } from '../../provider';

import { apiError } from './shared';

import type { ProviderConfig } from '../../config/provider';

const logger = createLogger('api:providers');

type ProviderConfigView = Omit<ProviderConfig, 'apiKey'> & {
  hasApiKey: boolean;
  id: string;
  status: 'active' | 'inactive';
};

function providerView(id: string, config: ProviderConfig): ProviderConfigView {
  const { apiKey, ...rest } = config;
  return {
    ...rest,
    hasApiKey: apiKey !== undefined && apiKey !== '',
    id,
    status: ProviderRegistry.instance.getProvider(id) ? 'active' : 'inactive',
  };
}

const providerRoutes = new Elysia({ prefix: '/api/v1' })
  .get('/providers', () => Object.entries(Config.get('providers'))
    .map(([id, config]) => providerView(id, config)))
  .get('/providers/:providerId', ({ params, status }) => {
    const config = Config.get('providers')[params.providerId];
    if (!config) {
      return status(404, apiError('not_found', `Provider with id ${params.providerId} not found.`));
    }
    return providerView(params.providerId, config);
  }, {
    params: z.object({ providerId: providerIdSchema }),
  })
  .get('/providers/:providerId/models', ({ params, status }) => {
    const provider = ProviderRegistry.instance.getProvider(params.providerId);
    if (provider) {
      return provider.listModelConfigs();
    }
    if (Config.get('providers')[params.providerId]) {
      return status(503, apiError(
        'service_unavailable',
        `Provider with id ${params.providerId} is configured but inactive; a restart or configuration change may be required.`,
      ));
    }
    return status(404, apiError('not_found', `Provider with id ${params.providerId} not found.`));
  }, {
    params: z.object({ providerId: providerIdSchema }),
  })
  .post('/providers', async ({ body, status }) => {
    if (Config.get('providers')[body.id]) {
      return status(409, apiError('conflict', `Provider with id ${body.id} already exists.`));
    }
    try {
      const saved = await upsertProviderConfig(Config.get('env'), body.id, body.config);
      return status(201, { provider: providerView(body.id, saved), restartRequired: true });
    } catch (error) {
      logger.error({ err: error, providerId: body.id }, 'Failed to persist a new provider configuration.');
      return status(500, apiError('internal_error', 'Failed to persist the provider configuration.'));
    }
  }, {
    body: z.object({
      id: providerIdSchema,
      config: providerConfigSchema,
    }),
  })
  .put('/providers/:providerId', async ({ params, body, status }) => {
    if (!Config.get('providers')[params.providerId]) {
      return status(404, apiError('not_found', `Provider with id ${params.providerId} not found.`));
    }
    try {
      const saved = await upsertProviderConfig(Config.get('env'), params.providerId, body);
      return { provider: providerView(params.providerId, saved), restartRequired: true };
    } catch (error) {
      logger.error({ err: error, providerId: params.providerId }, 'Failed to persist a provider configuration.');
      return status(500, apiError('internal_error', 'Failed to persist the provider configuration.'));
    }
  }, {
    params: z.object({ providerId: providerIdSchema }),
    body: providerConfigSchema,
  })
  .delete('/providers/:providerId', async ({ params, status }) => {
    if (!Config.get('providers')[params.providerId]) {
      return status(404, apiError('not_found', `Provider with id ${params.providerId} not found.`));
    }
    const dependentBlueprints = AgentRegistry.instance.listBlueprints()
      .filter((blueprint) => blueprint.config.providerId === params.providerId)
      .map((blueprint) => blueprint.id);
    if (dependentBlueprints.length > 0) {
      return status(409, apiError(
        'conflict',
        `Provider ${params.providerId} is used by blueprints: ${dependentBlueprints.join(', ')}.`,
      ));
    }
    try {
      await deleteProviderConfig(Config.get('env'), params.providerId);
      return { restartRequired: true };
    } catch (error) {
      logger.error({ err: error, providerId: params.providerId }, 'Failed to delete a provider configuration.');
      return status(500, apiError('internal_error', 'Failed to delete the provider configuration.'));
    }
  }, {
    params: z.object({ providerId: providerIdSchema }),
  });

export {
  providerRoutes,
};
