import { MEMORY_FACT_KINDS, type MemoryOwnerScope, type MemoryScope } from '@nox/extension-api';
import { Elysia } from 'elysia';
import { z } from 'zod';

import { authGuard } from '../auth/guard';

import type { MemoryRuntime } from '../../runtime/configurationRuntime';
import type { AuthStore } from '../auth/store';

const memoryIdSchema = z.string().trim().min(1).max(128);
const factIdSchema = z.string().trim().min(1).max(256);
const memoryParamsSchema = z.object({ memoryId: memoryIdSchema });
const factParamsSchema = memoryParamsSchema.extend({ factId: factIdSchema });
const ownerShape = {
  agentId: z.string().trim().min(1).max(128),
  issuer: z.string().trim().min(1).max(256),
  subject: z.string().trim().min(1).max(256),
};
const inspectionQuerySchema = z.object({
  ...ownerShape,
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const factMutationShape = {
  ...ownerShape,
  // The same closed vocabulary the agent's tools write through: an owner
  // correcting a fact by hand must not be able to invent a kind either.
  kind: z.enum(MEMORY_FACT_KINDS),
  text: z.string().trim().min(1).max(4_000),
  validFrom: z.iso.datetime({ offset: true }).optional(),
};
const writeFactSchema = z.object(factMutationShape);
const updateFactSchema = z.object(factMutationShape);
const forgetFactQuerySchema = z.object({
  ...ownerShape,
  validTo: z.iso.datetime({ offset: true }).optional(),
});

interface MemoryRoutesOptions {
  readonly memories: MemoryRuntime;
  readonly store: AuthStore;
}

interface OwnerInput {
  readonly agentId: string;
  readonly issuer: string;
  readonly subject: string;
}

function owner(input: OwnerInput): MemoryOwnerScope {
  return {
    agentId: input.agentId,
    principal: { issuer: input.issuer, subject: input.subject },
  };
}

function operationScope(
  input: z.infer<typeof writeFactSchema>,
  authenticationSessionId: string,
): MemoryScope {
  return {
    ...owner(input),
    sessionId: `nox.memory.audit:${authenticationSessionId}`,
  };
}

/** Owner-only inspection and correction over optional memory capabilities. */
function createMemoryRoutes(options: MemoryRoutesOptions) {
  return new Elysia({ name: 'nox.api.memories.routes' })
    .use(authGuard(options.store))
    .get(
      '/memories',
      () => ({ memories: options.memories.memoryInventory() }),
      { authenticated: true },
    )
    .get(
      '/memories/:memoryId/scopes',
      async ({ params, request, status }) => {
        const memory = options.memories.memory(params.memoryId);
        if (memory === undefined) return status(404, { error: 'memory_not_found' });
        if (memory.inspector === undefined) {
          return status(409, { error: 'memory_not_inspectable' });
        }
        return { scopes: await memory.inspector.scopes(request.signal) };
      },
      { authenticated: true, params: memoryParamsSchema },
    )
    .get(
      '/memories/:memoryId/facts',
      async ({ params, query, request, status }) => {
        const memory = options.memories.memory(params.memoryId);
        if (memory === undefined) return status(404, { error: 'memory_not_found' });
        if (memory.inspector === undefined) {
          return status(409, { error: 'memory_not_inspectable' });
        }
        return memory.inspector.facts({
          limit: query.limit,
          offset: query.offset,
          scope: owner(query),
          signal: request.signal,
        });
      },
      { authenticated: true, params: memoryParamsSchema, query: inspectionQuerySchema },
    )
    .get(
      '/memories/:memoryId/episodes',
      async ({ params, query, request, status }) => {
        const memory = options.memories.memory(params.memoryId);
        if (memory === undefined) return status(404, { error: 'memory_not_found' });
        if (memory.inspector === undefined) {
          return status(409, { error: 'memory_not_inspectable' });
        }
        return memory.inspector.episodes({
          limit: query.limit,
          offset: query.offset,
          scope: owner(query),
          signal: request.signal,
        });
      },
      { authenticated: true, params: memoryParamsSchema, query: inspectionQuerySchema },
    )
    .post(
      '/memories/:memoryId/facts',
      async ({ body, params, request, sessionId, status }) => {
        const memory = options.memories.memory(params.memoryId);
        if (memory === undefined) return status(404, { error: 'memory_not_found' });
        if (memory.editor === undefined) return status(409, { error: 'memory_not_editable' });
        const fact = await memory.editor.write({
          kind: body.kind,
          scope: operationScope(body, sessionId),
          signal: request.signal,
          text: body.text,
          ...(body.validFrom === undefined ? {} : { validFrom: body.validFrom }),
        });
        return status(201, { fact });
      },
      { authenticated: true, body: writeFactSchema, params: memoryParamsSchema },
    )
    .put(
      '/memories/:memoryId/facts/:factId',
      async ({ body, params, request, sessionId, status }) => {
        const memory = options.memories.memory(params.memoryId);
        if (memory === undefined) return status(404, { error: 'memory_not_found' });
        if (memory.editor === undefined) return status(409, { error: 'memory_not_editable' });
        const fact = await memory.editor.update({
          id: params.factId,
          kind: body.kind,
          scope: operationScope(body, sessionId),
          signal: request.signal,
          text: body.text,
          ...(body.validFrom === undefined ? {} : { validFrom: body.validFrom }),
        });
        return fact === undefined
          ? status(404, { error: 'fact_not_found' })
          : { fact };
      },
      { authenticated: true, body: updateFactSchema, params: factParamsSchema },
    )
    .delete(
      '/memories/:memoryId/facts/:factId',
      async ({ params, query, request, sessionId, status }) => {
        const memory = options.memories.memory(params.memoryId);
        if (memory === undefined) return status(404, { error: 'memory_not_found' });
        if (memory.editor === undefined) return status(409, { error: 'memory_not_editable' });
        const forgotten = await memory.editor.forget({
          id: params.factId,
          scope: {
            ...owner(query),
            sessionId: `nox.memory.audit:${sessionId}`,
          },
          signal: request.signal,
          ...(query.validTo === undefined ? {} : { validTo: query.validTo }),
        });
        return forgotten ? status(204, undefined) : status(404, { error: 'fact_not_found' });
      },
      { authenticated: true, params: factParamsSchema, query: forgetFactQuerySchema },
    );
}

function memoryRoutes(options: MemoryRoutesOptions): ReturnType<typeof createMemoryRoutes> {
  return createMemoryRoutes(options);
}

export { memoryRoutes };

export type { MemoryRoutesOptions };
