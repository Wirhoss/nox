import { Elysia, sse } from 'elysia';
import { z } from 'zod';

import { AgentRegistry } from '../../agent/registry';
import { MessageGateway } from '../../gateway';

import { idParamsSchema, resourceIdSchema } from './shared';

function isNotFound(error: unknown): boolean {
  return error instanceof Error && /not found|no session bound/i.test(error.message);
}

const sessionRoutes = new Elysia({ prefix: '/api/v1' })
  .get('/sessions', () => AgentRegistry.instance.listSessions())
  .post('/sessions', ({ body, status }) => {
    try {
      return status(201, MessageGateway.instance.createSession(body.blueprintId));
    } catch (error) {
      return status(isNotFound(error) ? 404 : 500, { message: (error as Error).message });
    }
  }, {
    body: z.object({ blueprintId: z.string() }),
  })
  .get('/sessions/:id', ({ params, status }) => {
    try {
      return MessageGateway.instance.getHistory(params.id);
    } catch (error) {
      return status(isNotFound(error) ? 404 : 500, { message: (error as Error).message });
    }
  }, {
    params: idParamsSchema,
  })
  .post('/sessions/:id/messages', ({ body, params, status }) => {
    try {
      return status(202, MessageGateway.instance.sendMessage(params.id, body.text, { steer: body.steer }));
    } catch (error) {
      return status(isNotFound(error) ? 404 : 500, { message: (error as Error).message });
    }
  }, {
    params: idParamsSchema,
    body: z.object({
      text: z.string().min(1),
      steer: z.boolean().optional(),
    }),
  })
  .delete('/sessions/:id', async ({ params, status }) => {
    try {
      await MessageGateway.instance.deleteSession(params.id);
      return status(204, undefined);
    } catch (error) {
      return status(isNotFound(error) ? 404 : 500, { message: (error as Error).message });
    }
  }, {
    params: idParamsSchema,
  })
  .post('/sessions/:id/abort', async ({ params, status }) => {
    try {
      return await MessageGateway.instance.abortRun(params.id);
    } catch (error) {
      return status(isNotFound(error) ? 404 : 500, { message: (error as Error).message });
    }
  }, {
    params: idParamsSchema,
  })
  .get('/sessions/:id/permissions', ({ params, status }) => {
    try {
      return MessageGateway.instance.listPendingPermissions(params.id);
    } catch (error) {
      return status(isNotFound(error) ? 404 : 500, { message: (error as Error).message });
    }
  }, {
    params: idParamsSchema,
  })
  .post('/sessions/:id/permissions/:requestId', ({ body, params, status }) => {
    try {
      const resolved = MessageGateway.instance.resolvePermission(params.id, params.requestId, body.approved);
      if (!resolved) {
        return status(404, { message: 'Permission request not found or already resolved.' });
      }
      return { resolved: true };
    } catch (error) {
      return status(isNotFound(error) ? 404 : 500, { message: (error as Error).message });
    }
  }, {
    params: z.object({ id: resourceIdSchema, requestId: resourceIdSchema }),
    body: z.object({ approved: z.boolean() }),
  })
  .get('/sessions/:id/events', async function* ({ params, query, status }) {
    let events: AsyncGenerator<{ cursor: number; event: { type: string } }>;
    try {
      events = MessageGateway.instance.subscribe(params.id, query.from ?? 0);
    } catch (error) {
      return status(isNotFound(error) ? 404 : 500, { message: (error as Error).message });
    }
    for await (const { cursor, event } of events) {
      yield sse({ id: String(cursor), event: event.type, data: event });
    }
  }, {
    params: idParamsSchema,
    query: z.object({
      from: z.coerce.number().int().min(0).optional(),
    }),
  });

export {
  sessionRoutes,
};
