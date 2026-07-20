import { Elysia } from 'elysia';

import { Config } from '../../config';
import { updateGateConfig } from '../../config/app';
import { updateWebToolsConfig } from '../../config/tools';
import { gateConfigSchema } from '../../gate';
import { webServicesCatalog, webToolsConfigSchema } from '../../tool/tools';

import { apiError } from './shared';

import type { WebToolsConfig } from '../../tool/tools';

type CapabilityConfigView = {
  contract: unknown;
  hasApiKey: boolean;
  service: string;
  serviceConfig: Record<string, unknown>;
};

type WebToolsConfigView = {
  web_extract?: CapabilityConfigView;
  web_search?: CapabilityConfigView;
};

function webToolsConfigView(config: WebToolsConfig): WebToolsConfigView {
  const capabilityView = <T extends {
    contract: unknown;
    service: string;
    serviceConfig: { apiKey?: string } & Record<string, unknown>;
  }>(capability: T | undefined): CapabilityConfigView | undefined => {
    if (!capability) return undefined;
    const { apiKey, ...serviceConfig } = capability.serviceConfig;
    return {
      service: capability.service,
      serviceConfig,
      contract: capability.contract,
      hasApiKey: apiKey !== undefined && apiKey !== '',
    };
  };
  return {
    ...(config.web_search ? { web_search: capabilityView(config.web_search) } : {}),
    ...(config.web_extract ? { web_extract: capabilityView(config.web_extract) } : {}),
  };
}

const configRoutes = new Elysia({ prefix: '/api/v1' })
  .get('/config/tools/web_tools', () => ({
    config: webToolsConfigView(Config.get('tools').web_tools ?? {}),
    services: webServicesCatalog(),
  }))
  .put('/config/tools/web_tools', async ({ body, status }) => {
    try {
      const saved = await updateWebToolsConfig(Config.get('env'), body);
      return {
        config: webToolsConfigView(saved),
        services: webServicesCatalog(),
        restartRequired: false,
      };
    } catch {
      return status(500, apiError('internal_error', 'Failed to persist the web tools configuration.'));
    }
  }, {
    body: webToolsConfigSchema,
  })
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
  webToolsConfigView,
};
