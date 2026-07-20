import { Elysia } from 'elysia';

import { Config } from '../../config';
import { updateGateConfig } from '../../config/app';
import { gateConfigSchema } from '../../gate';

import { apiError } from './shared';

const configRoutes = new Elysia({ prefix: '/api/v1' })
  .get('/config/gate', () => Config.get('app').gate)
  .put('/config/gate', async ({ body, status }) => {
    try {
      const gate = await updateGateConfig(Config.get('env'), body);
      return { gate, restartRequired: true };
    } catch {
      return status(500, apiError('internal_error', 'Failed to persist gate configuration.'));
    }
  }, {
    body: gateConfigSchema,
  });

export {
  configRoutes,
};
