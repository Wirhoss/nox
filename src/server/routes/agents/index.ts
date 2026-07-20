import { Elysia } from 'elysia';
import { z } from 'zod';

import { AgentRegistry, agentBlueprintSchema } from '../../../agent/registry';
import { Config } from '../../../config';
import { deleteAgentConfig, upsertAgentConfig } from '../../../config/agent';
import { ProviderRegistry } from '../../../provider';
import { ToolRegistry } from '../../../tool/registry';
import { agentParamsSchema } from '../shared';

import { agentSessionRoutes } from './sessions';

import type { AgentBlueprint } from '../../../agent/registry';

// Schema validation alone lets a blueprint reference providers, models or
// tool sets that don't exist; those only blow up at session creation, so
// check them against the live registries at save time instead.
function findMissingReferences(blueprint: AgentBlueprint): string[] {
  const errors: string[] = [];
  const provider = ProviderRegistry.instance.getProvider(blueprint.config.providerId);
  if (!provider) {
    errors.push(`Provider with id ${blueprint.config.providerId} not found.`);
  } else if (!provider.getModelConfig(blueprint.config.modelId)) {
    errors.push(`Model with id ${blueprint.config.modelId} not found in provider ${blueprint.config.providerId}.`);
  }
  for (const toolSetId of [...blueprint.coreTools, ...blueprint.lazyLoadedTools]) {
    if (!ToolRegistry.instance.getToolSetClass(toolSetId)) {
      errors.push(`Tool set with id ${toolSetId} not found.`);
    }
  }
  return errors;
}

const agentRoutes = new Elysia({ prefix: '/api/v1' })
  .get('/agents', ({ query }) => {
    const blueprints = AgentRegistry.instance.listBlueprints();
    if (!query.q) {
      return blueprints;
    }
    const q = query.q.toLowerCase();
    return blueprints.filter((blueprint) =>
      blueprint.id.toLowerCase().includes(q)
      || blueprint.description.toLowerCase().includes(q)
    );
  }, {
    query: z.object({ q: z.string().optional() }),
  })
  .get('/agents/:agentId', ({ params, status }) => {
    const blueprint = AgentRegistry.instance.getBlueprint(params.agentId);
    if (!blueprint) {
      return status(404, { message: `Agent blueprint with id ${params.agentId} not found.` });
    }
    return blueprint;
  }, {
    params: agentParamsSchema,
  })
  .post('/agents', async ({ body, status }) => {
    if (AgentRegistry.instance.getBlueprint(body.id)) {
      return status(409, { message: `Agent blueprint with id ${body.id} already exists.` });
    }
    const missing = findMissingReferences(body);
    if (missing.length > 0) {
      return status(422, { message: missing.join(' ') });
    }
    try {
      const saved = await upsertAgentConfig(Config.get('env'), body);
      AgentRegistry.instance.upsertBlueprint(saved);
      return status(201, saved);
    } catch (error) {
      return status(500, { message: (error as Error).message });
    }
  }, {
    body: agentBlueprintSchema,
  })
  .put('/agents/:agentId', async ({ params, body, status }) => {
    if (body.id !== params.agentId) {
      return status(400, { message: `Blueprint id "${body.id}" does not match URL id "${params.agentId}".` });
    }
    if (!AgentRegistry.instance.getBlueprint(params.agentId)) {
      return status(404, { message: `Agent blueprint with id ${params.agentId} not found.` });
    }
    const missing = findMissingReferences(body);
    if (missing.length > 0) {
      return status(422, { message: missing.join(' ') });
    }
    try {
      const saved = await upsertAgentConfig(Config.get('env'), body);
      AgentRegistry.instance.upsertBlueprint(saved);
      return status(200, saved);
    } catch (error) {
      return status(500, { message: (error as Error).message });
    }
  }, {
    params: agentParamsSchema,
    body: agentBlueprintSchema,
  })
  .delete('/agents/:agentId', async ({ params, status }) => {
    if (!AgentRegistry.instance.getBlueprint(params.agentId)) {
      return status(404, { message: `Agent blueprint with id ${params.agentId} not found.` });
    }
    try {
      await deleteAgentConfig(Config.get('env'), params.agentId);
      AgentRegistry.instance.removeBlueprint(params.agentId);
      return status(204, undefined);
    } catch (error) {
      return status(500, { message: (error as Error).message });
    }
  }, {
    params: agentParamsSchema,
  })
  .use(agentSessionRoutes);

export {
  agentRoutes,
};
