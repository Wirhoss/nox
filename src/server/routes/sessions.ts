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

const SSE_HEARTBEAT_MS = 15_000;

async function nextWithHeartbeat<T>(pending: Promise<IteratorResult<T>>): Promise<IteratorResult<T> | null> {
  return await new Promise<IteratorResult<T> | null>((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), SSE_HEARTBEAT_MS);
    pending.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

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
    const sessions = AgentRegistry.instance.listSessionsWithStats(query.blueprintId);
    return sessions
      .slice(query.offset, query.offset + query.limit)
      .map((session) => ({
        ...toSessionSummary(session),
        latestRun: session.latestRun,
        runCount: session.runCount,
        usage: session.usage,
      }));
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
  .get('/sessions/:sessionId', ({ params, query, status }) => {
    try {
      const snapshot = AgentRegistry.instance.getSessionSnapshot(params.sessionId, query.activityLimit);
      return {
        activityCount: snapshot.activityCount,
        eventCursor: snapshot.eventCursor,
        isRunning: snapshot.isRunning,
        latestRun: snapshot.latestRun,
        messageEntries: snapshot.messageEntries,
        messages: snapshot.messages,
        recentActivities: snapshot.recentActivities,
        runs: snapshot.runs,
        session: toSessionSummary(snapshot.session),
      };
    } catch (error) {
      return status(errorStatus(error), errorBody(error));
    }
  }, {
    params: sessionParamsSchema,
    query: z.object({
      activityLimit: z.coerce.number().int().min(1).max(500).default(50),
    }),
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
  .get('/sessions/:sessionId/events', async function* ({ params, query, set, status }) {
    let events;
    try {
      events = MessageGateway.instance.subscribe(params.sessionId, query.from ?? 0);
    } catch (error) {
      return status(errorStatus(error), errorBody(error));
    }
    set.headers['cache-control'] = 'no-cache, no-transform';
    set.headers['x-accel-buffering'] = 'no';

    let pending = events.next();
    while (true) {
      const result = await nextWithHeartbeat(pending);
      if (result === null) {
        yield sse({ event: 'heartbeat', data: { timestamp: Date.now() } });
        continue;
      }
      if (result.done) return;
      const { cursor, event } = result.value;
      yield sse({ id: String(cursor), event: event.type, data: event });
      pending = events.next();
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
