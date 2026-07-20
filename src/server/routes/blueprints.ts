import { Elysia } from 'elysia';
import { z } from 'zod';

import { AgentRegistry, agentBlueprintSchema } from '../../agent/registry';
import { Config } from '../../config';
import { deleteBlueprintConfig, upsertBlueprintConfig } from '../../config/blueprint';
import { ProviderRegistry } from '../../provider';
import { ToolRegistry } from '../../tool/registry';

import { apiError, blueprintParamsSchema } from './shared';

import type { AgentBlueprint } from '../../agent/registry';

function findInvalidReferences(
  blueprint: AgentBlueprint,
  allowedUnavailableTools: ReadonlySet<string> = new Set(),
): string[] {
  const errors: string[] = [];
  const configuredProvider = Config.get('providers')[blueprint.config.providerId];
  const activeProvider = ProviderRegistry.instance.getProvider(blueprint.config.providerId);

  if (!configuredProvider) {
    errors.push(`Provider with id ${blueprint.config.providerId} is not configured.`);
  } else if (activeProvider && !activeProvider.getModelConfig(blueprint.config.modelId)) {
    errors.push(`Model with id ${blueprint.config.modelId} is not available in provider ${blueprint.config.providerId}.`);
  }

  for (const toolSetId of [...blueprint.coreTools, ...blueprint.lazyLoadedTools]) {
    if (!ToolRegistry.instance.getToolSetClass(toolSetId) && !allowedUnavailableTools.has(toolSetId)) {
      errors.push(`Tool set with id ${toolSetId} is not available.`);
    }
  }
  return errors;
}

const blueprintRoutes = new Elysia({ prefix: '/api/v1' })
  .get('/blueprints', ({ query }) => {
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
    query: z.object({ q: z.string().trim().min(1).optional() }),
  })
  .get('/blueprints/:blueprintId', ({ params, status }) => {
    const blueprint = AgentRegistry.instance.getBlueprint(params.blueprintId);
    if (!blueprint) {
      return status(404, apiError('not_found', `Blueprint with id ${params.blueprintId} not found.`));
    }
    return blueprint;
  }, {
    params: blueprintParamsSchema,
  })
  .post('/blueprints', async ({ body, status }) => {
    if (AgentRegistry.instance.getBlueprint(body.id)) {
      return status(409, apiError('conflict', `Blueprint with id ${body.id} already exists.`));
    }
    const invalid = findInvalidReferences(body);
    if (invalid.length > 0) {
      return status(422, apiError('validation_error', invalid.join(' ')));
    }
    try {
      const saved = await upsertBlueprintConfig(Config.get('env'), body);
      AgentRegistry.instance.upsertBlueprint(saved);
      return status(201, saved);
    } catch {
      return status(500, apiError('internal_error', 'Failed to persist the blueprint.'));
    }
  }, {
    body: agentBlueprintSchema,
  })
  .put('/blueprints/:blueprintId', async ({ params, body, status }) => {
    if (body.id !== params.blueprintId) {
      return status(400, apiError('validation_error', `Blueprint id "${body.id}" does not match URL id "${params.blueprintId}".`));
    }
    const existing = AgentRegistry.instance.getBlueprint(params.blueprintId);
    if (!existing) {
      return status(404, apiError('not_found', `Blueprint with id ${params.blueprintId} not found.`));
    }
    // Existing installations may reference a plugin-provided tool that is not
    // currently loaded. Preserve those references on a round trip, but do not
    // accept new unknown tool ids.
    const existingTools = new Set([...existing.coreTools, ...existing.lazyLoadedTools]);
    const invalid = findInvalidReferences(body, existingTools);
    if (invalid.length > 0) {
      return status(422, apiError('validation_error', invalid.join(' ')));
    }
    try {
      const saved = await upsertBlueprintConfig(Config.get('env'), body);
      AgentRegistry.instance.upsertBlueprint(saved);
      return saved;
    } catch {
      return status(500, apiError('internal_error', 'Failed to persist the blueprint.'));
    }
  }, {
    params: blueprintParamsSchema,
    body: agentBlueprintSchema,
  })
  .delete('/blueprints/:blueprintId', async ({ params, status }) => {
    if (!AgentRegistry.instance.getBlueprint(params.blueprintId)) {
      return status(404, apiError('not_found', `Blueprint with id ${params.blueprintId} not found.`));
    }
    const sessionCount = AgentRegistry.instance.listSessions(params.blueprintId).length;
    if (sessionCount > 0) {
      return status(409, apiError(
        'conflict',
        `Blueprint ${params.blueprintId} is used by ${sessionCount} stored ${sessionCount === 1 ? 'session' : 'sessions'}.`,
      ));
    }
    try {
      await deleteBlueprintConfig(Config.get('env'), params.blueprintId);
      AgentRegistry.instance.removeBlueprint(params.blueprintId);
      return status(204, undefined);
    } catch {
      return status(500, apiError('internal_error', 'Failed to delete the blueprint.'));
    }
  }, {
    params: blueprintParamsSchema,
  });

export {
  blueprintRoutes,
};
