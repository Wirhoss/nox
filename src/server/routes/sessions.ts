import { Elysia, sse } from 'elysia';
import { z } from 'zod';

import { AgentRegistry } from '../../agent/registry';
import { MessageGateway } from '../../gateway';

import {
  apiError,
  errorBody,
  errorStatus,
  resourceIdSchema,
  sessionParamsSchema,
} from './shared';

import type { SessionRecord } from '../../database';

function toSessionSummary(record: SessionRecord) {
  return {
    blueprintId: record.blueprintId,
    createdAt: record.createdAt,
    sessionId: record.sessionId,
    updatedAt: record.updatedAt,
  };
}

const sessionRoutes = new Elysia({ prefix: '/api/v1' })
  .get('/sessions', ({ query }) => {
    const sessions = AgentRegistry.instance.listSessions(query.blueprintId);
    return sessions
      .slice(query.offset, query.offset + query.limit)
      .map(toSessionSummary);
  }, {
    query: z.object({
      blueprintId: resourceIdSchema.optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  })
  .post('/sessions', ({ body, status }) => {
    try {
      return status(201, MessageGateway.instance.createSession(body.blueprintId));
    } catch (error) {
      return status(errorStatus(error), errorBody(error));
    }
  }, {
    body: z.object({ blueprintId: resourceIdSchema }),
  })
  .get('/sessions/:sessionId', ({ params, status }) => {
    try {
      const snapshot = AgentRegistry.instance.getSessionSnapshot(params.sessionId);
      return {
        eventCursor: snapshot.eventCursor,
        messages: snapshot.messages,
        session: toSessionSummary(snapshot.session),
      };
    } catch (error) {
      return status(errorStatus(error), errorBody(error));
    }
  }, {
    params: sessionParamsSchema,
  })
  .post('/sessions/:sessionId/messages', ({ body, params, status }) => {
    try {
      return status(202, MessageGateway.instance.sendMessage(params.sessionId, body.text, { steer: body.steer }));
    } catch (error) {
      return status(errorStatus(error), errorBody(error));
    }
  }, {
    params: sessionParamsSchema,
    body: z.object({
      text: z.string().trim().min(1),
      steer: z.boolean().optional(),
    }),
  })
  .delete('/sessions/:sessionId', async ({ params, status }) => {
    try {
      await MessageGateway.instance.deleteSession(params.sessionId);
      return status(204, undefined);
    } catch (error) {
      return status(errorStatus(error), errorBody(error));
    }
  }, {
    params: sessionParamsSchema,
  })
  .post('/sessions/:sessionId/abort', async ({ params, status }) => {
    try {
      return await MessageGateway.instance.abortRun(params.sessionId);
    } catch (error) {
      return status(errorStatus(error), errorBody(error));
    }
  }, {
    params: sessionParamsSchema,
  })
  .get('/sessions/:sessionId/permissions', ({ params, status }) => {
    try {
      return MessageGateway.instance.listPendingPermissions(params.sessionId);
    } catch (error) {
      return status(errorStatus(error), errorBody(error));
    }
  }, {
    params: sessionParamsSchema,
  })
  .post('/sessions/:sessionId/permissions/:requestId', ({ body, params, status }) => {
    try {
      const resolved = MessageGateway.instance.resolvePermission(params.sessionId, params.requestId, body.approved);
      if (!resolved) {
        return status(404, apiError('not_found', 'Permission request not found or already resolved.'));
      }
      return { resolved: true };
    } catch (error) {
      return status(errorStatus(error), errorBody(error));
    }
  }, {
    params: z.object({ sessionId: resourceIdSchema, requestId: resourceIdSchema }),
    body: z.object({ approved: z.boolean() }),
  })
  .get('/sessions/:sessionId/events', async function* ({ params, query, status }) {
    let events;
    try {
      events = MessageGateway.instance.subscribe(params.sessionId, query.from ?? 0);
    } catch (error) {
      return status(errorStatus(error), errorBody(error));
    }
    for await (const { cursor, event } of events) {
      yield sse({ id: String(cursor), event: event.type, data: event });
    }
  }, {
    params: sessionParamsSchema,
    query: z.object({
      from: z.coerce.number().int().min(0).optional(),
    }),
  });

export {
  sessionRoutes,
};
