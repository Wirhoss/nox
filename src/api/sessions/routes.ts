import { Elysia } from 'elysia';
import { z } from 'zod';

import { authGuard } from '../auth/guard';

import type {
  AuditAction,
  AuditActionList,
  SessionAgentSummary,
  SessionList,
  SessionSummary,
  StoredSession,
} from '../../database/sessionStore';
import type { AuthStore } from '../auth/store';

const sessionIdSchema = z.string().trim().min(1).max(128);
const sessionParamsSchema = z.object({ sessionId: sessionIdSchema });
const sessionsQuerySchema = z.object({
  /** Absent means historical sessions whose agent attribution predates this field. */
  agentId: z.string().trim().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const transcriptQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1_000).default(500),
});
const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

interface SessionReader {
  listAuditActions(sessionId: string, limit?: number, offset?: number): Promise<AuditActionList>;
  listSessionAgents(): Promise<readonly SessionAgentSummary[]>;
  listSessions(agentId: null | string, limit?: number, offset?: number): Promise<SessionList>;
  load(sessionId: string): Promise<StoredSession | undefined>;
  readSession(sessionId: string): Promise<SessionSummary | undefined>;
}

interface SessionRoutesOptions {
  readonly sessions: SessionReader;
  readonly store: AuthStore;
}

/** Owner-only historical sessions and the two projections a session can open. */
function createSessionRoutes(options: SessionRoutesOptions) {
  return new Elysia({ name: 'nox.api.sessions.routes' })
    .use(authGuard(options.store))
    .get(
      '/sessions/agents',
      async () => ({
        agents: (await options.sessions.listSessionAgents()).map(serializeAgent),
      }),
      { authenticated: true },
    )
    .get(
      '/sessions',
      async ({ query }) => {
        const page = await options.sessions.listSessions(
          query.agentId ?? null,
          query.limit,
          query.offset,
        );
        return { ...page, entries: page.entries.map(serializeSession) };
      },
      { authenticated: true, query: sessionsQuerySchema },
    )
    .get(
      '/sessions/:sessionId',
      async ({ params, status }) => {
        const session = await options.sessions.readSession(params.sessionId);
        return session === undefined
          ? status(404, { error: 'session_not_found' })
          : serializeSession(session);
      },
      { authenticated: true, params: sessionParamsSchema },
    )
    .get(
      '/sessions/:sessionId/transcript',
      async ({ params, query, status }) => {
        const stored = await options.sessions.load(params.sessionId);
        if (stored === undefined) return status(404, { error: 'session_not_found' });
        const messages = stored.messages.slice(-query.limit);
        return {
          entries: messages.map((message) => ({
            ...message,
            createdAt: message.createdAt.toISOString(),
          })),
          session: serializeSession({
            ...(stored.session.agentId === null ? {} : { agentId: stored.session.agentId }),
            createdAt: new Date(stored.session.createdAt),
            sessionId: stored.session.sessionId,
            ...(stored.session.title === null ? {} : { title: stored.session.title }),
            updatedAt: new Date(stored.session.updatedAt),
          }),
          total: stored.messages.length,
        };
      },
      { authenticated: true, params: sessionParamsSchema, query: transcriptQuerySchema },
    )
    .get(
      '/sessions/:sessionId/audit',
      async ({ params, query, status }) => {
        if ((await options.sessions.readSession(params.sessionId)) === undefined) {
          return status(404, { error: 'session_not_found' });
        }
        const page = await options.sessions.listAuditActions(
          params.sessionId,
          query.limit,
          query.offset,
        );
        return { ...page, entries: page.entries.map(serializeAction) };
      },
      { authenticated: true, params: sessionParamsSchema, query: auditQuerySchema },
    );
}

function serializeAgent(agent: SessionAgentSummary) {
  return {
    agentId: agent.agentId ?? null,
    lastSessionAt: agent.lastSessionAt.toISOString(),
    sessionCount: agent.sessionCount,
  };
}

function serializeSession(session: SessionSummary) {
  return {
    agentId: session.agentId ?? null,
    createdAt: session.createdAt.toISOString(),
    sessionId: session.sessionId,
    ...(session.title === undefined ? {} : { title: session.title }),
    updatedAt: session.updatedAt.toISOString(),
  };
}

function serializeAction(action: AuditAction) {
  return {
    ...action,
    createdAt: action.createdAt.toISOString(),
    decisions: action.decisions.map((decision) => ({
      ...decision,
      createdAt: decision.createdAt.toISOString(),
      ...(decision.resolvedAt === undefined
        ? {}
        : { resolvedAt: decision.resolvedAt.toISOString() }),
    })),
    responses: action.responses.map((response) => ({
      ...response,
      createdAt: response.createdAt.toISOString(),
    })),
  };
}

function sessionRoutes(options: SessionRoutesOptions): ReturnType<typeof createSessionRoutes> {
  return createSessionRoutes(options);
}

export { sessionRoutes };

export type { SessionReader, SessionRoutesOptions };
