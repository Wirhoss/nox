import { Elysia } from 'elysia';
import { nanoid } from 'nanoid';
import { z } from 'zod';

import { type ContentPart, speechContentSchema, textFromContent } from '../../content/content';
import { authGuard } from '../auth/guard';

import type { ArtifactPipeline } from '../../artifact/pipeline';
import type { AuthStore } from '../auth/store';
import type { ChatEvent, ChatHub, ChatTransport } from './transport';

/**
 * How often the stream says something when the conversation does not. Nothing
 * between a browser and a local Nox needs it, but a reverse proxy in front of
 * one will drop a connection that has been silent for a minute, and a comment
 * line is the cheapest thing that stops that.
 */
const HEARTBEAT_MS = 25_000;

/** Answered only while the internal transport is starting or shutting down. */
const UNAVAILABLE = { error: 'chat_unavailable' } as const;

/** A chat this surface never carried. Nothing was ever said in it here. */
const NO_CONVERSATION = { error: 'conversation_not_found' } as const;

/** A command name that is not in the catalog. */
const NO_COMMAND = { error: 'unknown_command' } as const;

/** A selected route that is not currently available. */
const unknownAgent = (agentId: string) => ({ agentId, error: 'unknown_agent' }) as const;

/** An artifact ID that is missing or belongs to another account. */
const INVALID_ARTIFACT = { error: 'invalid_artifact' } as const;

/**
 * A conversation is named by the client and bound by the runtime on the first
 * message it carries — there is no endpoint that creates one, because a chat
 * nobody has spoken in is not yet a session and Nox has nothing to remember
 * about it.
 *
 * The charset is narrow on purpose: this string becomes half of a storage key
 * and part of a session's title, so it stays to what a generated id needs.
 */
const conversationIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Use a generated id: letters, digits, dashes or underscores.');

const conversationParamsSchema = z.object({ conversationId: conversationIdSchema });

const permissionParamsSchema = conversationParamsSchema.extend({
  requestId: z.string().trim().min(1).max(64),
});

const messageSchema = z
  .object({
    /** Explicit route selected for a new Web conversation. */
    agentId: z.string().trim().min(1).max(64).optional(),
    /** Structured content is canonical; `text` keeps older text clients compatible. */
    content: speechContentSchema.optional(),
    /**
     * The client's own id for what it sent, so a retry after a lost response is
     * the same message rather than a second turn. Optional: a client that does not
     * retry has nothing to name.
     */
    messageId: z.string().trim().min(1).max(64).optional(),
    text: z.string().min(1).max(32_000).optional(),
  })
  .refine((body) => body.content !== undefined || body.text !== undefined, {
    message: 'Provide content or text.',
  });

const decisionSchema = z.object({
  decision: z.enum(['approve', 'deny']),
  /** Ignored for a denial. Absent on an approval means this call only. */
  scope: z.enum(['once', 'session']).optional(),
});

/**
 * A command's arguments are whatever its own schema says they are, and they are
 * checked against exactly that — once, in the catalog the client rendered from.
 * Validating them a second time here in a different dialect is how two
 * definitions of one command start disagreeing.
 */
const argumentsSchema = z.record(z.string(), z.unknown()).optional();

const commandParamsSchema = conversationParamsSchema.extend({
  command: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'Use a command name from /chat/commands.'),
});

/**
 * How much of a conversation to read back. The cap is a page rather than a
 * policy: a transcript that has been going for a week is not a JSON response.
 */
const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1_000).optional(),
});

interface ChatRoutesOptions {
  readonly artifacts?: ArtifactPipeline;
  readonly hub: ChatHub;
  readonly store: AuthStore;
}

/**
 * The browser's end of a conversation: one stream out, two posts in.
 *
 * Everything here is authenticated, and the account it authenticates is the
 * sender the transport vouches for — `accountId` rather than the username,
 * because a name is a label a person may change and a grant written against it
 * would quietly stop matching.
 *
 * The stream carries every conversation this Nox is having rather than one per
 * chat: a browser holds few connections per origin, and a client that wants to
 * show activity in a chat it does not have open would otherwise need one for
 * each. Which chat an event belongs to is on the event.
 */
function createChatRoutes(options: ChatRoutesOptions) {
  const { artifacts, hub, store } = options;
  const streamInstanceId = nanoid();

  const canonicalContent = async (
    content: readonly ContentPart[],
    accountId: string,
  ): Promise<readonly ContentPart[] | undefined> => {
    const canonical: ContentPart[] = [];
    for (const part of content) {
      if (part.type !== 'artifact') {
        canonical.push(part);
        continue;
      }
      const reference = await artifacts?.ref(part.artifact.artifactId, {
        id: accountId,
        type: 'account',
      });
      if (reference === undefined) return undefined;
      canonical.push({ artifact: reference, type: 'artifact' });
    }
    return canonical;
  };

  return (
    new Elysia({ name: 'nox.api.chat.routes' })
      .use(authGuard(store))

      /** Routes the Web surface may bind a new conversation to. */
      .get(
        '/chat/agents',
        ({ status }) => {
          const transport = hub.transport;
          if (transport === undefined) return status(503, UNAVAILABLE);
          return transport.listAgents();
        },
        { authenticated: true },
      )

      /**
       * Every command this Nox offers, with the schema of what each takes. A
       * client builds its palette, its slash commands or its buttons out of
       * this rather than hardcoding a list that goes stale the moment one is
       * added — which is the whole reason the catalog is published at all.
       */
      .get(
        '/chat/commands',
        ({ status }) => {
          const transport = hub.transport;
          if (transport === undefined) return status(503, UNAVAILABLE);
          return { commands: transport.listCommands() };
        },
        { authenticated: true },
      )

      /**
       * Every conversation this surface carries, most recently spoken in first.
       * The bindings rather than the live sessions: a chat nobody has reopened
       * since the last restart is still a conversation, and one missing from the
       * list would look deleted.
       */
      .get(
        '/chat/conversations',
        async ({ status }) => {
          const transport = hub.transport;
          if (transport === undefined) return status(503, UNAVAILABLE);
          return { conversations: await transport.listConversations() };
        },
        { authenticated: true },
      )

      /**
       * One conversation read back. A `GET` because it is one: asking what was
       * said opens no session and wakes no closed one, so a client redrawing a
       * chat never starts a run by looking at it.
       */
      .get(
        '/chat/conversations/:conversationId/history',
        async ({ params, query, status }) => {
          const transport = hub.transport;
          if (transport === undefined) return status(503, UNAVAILABLE);

          const history = await transport.readHistory({
            conversationId: params.conversationId,
            limit: query.limit,
          });
          return history ?? status(404, NO_CONVERSATION);
        },
        { authenticated: true, params: conversationParamsSchema, query: historyQuerySchema },
      )

      /** Everything the runtime renders, as it happens. */
      .get(
        '/chat/stream',
        ({ request, status }) => {
          const transport = hub.transport;
          if (transport === undefined) return status(503, UNAVAILABLE);
          return eventStream(
            transport,
            request.signal,
            streamInstanceId,
            requestedEventId(request),
          );
        },
        { authenticated: true },
      )

      /**
       * Says something. It answers as soon as the transport has the message, not
       * when the agent has replied: the reply arrives on the stream, and a turn
       * that takes a minute is not an HTTP request that takes a minute.
       */
      .post(
        '/chat/conversations/:conversationId/messages',
        async ({ account, body, params, status }) => {
          const transport = hub.transport;
          if (transport === undefined) return status(503, UNAVAILABLE);

          const messageId = body.messageId ?? nanoid();
          const submitted = body.content ?? [{ text: body.text ?? '', type: 'text' as const }];
          const content = await canonicalContent(submitted, account.accountId);
          if (content === undefined) return status(400, INVALID_ARTIFACT);
          const rejection = transport.submitMessage({
            ...(body.agentId === undefined ? {} : { agentId: body.agentId }),
            content,
            conversationId: params.conversationId,
            messageId,
            senderId: account.accountId,
            text: textFromContent(content).trim(),
          });

          switch (rejection?.reason) {
            case undefined:
              return status(202, { messageId });
            case 'agentRequired':
              return status(409, { agents: rejection.agents, error: 'agent_selection_required' });
            case 'unknownAgent':
              return status(409, unknownAgent(rejection.agentId));
            case 'unavailable':
              return status(503, UNAVAILABLE);
          }
        },
        { authenticated: true, body: messageSchema, params: conversationParamsSchema },
      )

      /**
       * Adds explicit direction at the next safe opening in the run in flight.
       *
       * A route and not a prefix on a message, for the same reason answering a
       * permission is: steering is transport intent, not prose for the model to
       * interpret. It queues behind the active operation rather than cancelling
       * it. What a surface does with what someone types remains the surface's
       * business, never the runtime's.
       */
      .post(
        '/chat/conversations/:conversationId/steer',
        async ({ account, body, params, status }) => {
          const transport = hub.transport;
          if (transport === undefined) return status(503, UNAVAILABLE);

          const messageId = body.messageId ?? nanoid();
          const submitted = body.content ?? [{ text: body.text ?? '', type: 'text' as const }];
          const content = await canonicalContent(submitted, account.accountId);
          if (content === undefined) return status(400, INVALID_ARTIFACT);
          const rejection = transport.submitSteer({
            ...(body.agentId === undefined ? {} : { agentId: body.agentId }),
            content,
            conversationId: params.conversationId,
            messageId,
            senderId: account.accountId,
            text: textFromContent(content).trim(),
          });

          switch (rejection?.reason) {
            case undefined:
              return status(202, { messageId });
            case 'agentRequired':
              return status(409, { agents: rejection.agents, error: 'agent_selection_required' });
            case 'unknownAgent':
              return status(409, unknownAgent(rejection.agentId));
            case 'unavailable':
              return status(503, UNAVAILABLE);
          }
        },
        { authenticated: true, body: messageSchema, params: conversationParamsSchema },
      )

      /**
       * Invokes a command in a conversation.
       *
       * A 202 means the invocation was accepted and queued, never that it
       * finished: a command waits its turn behind whatever else that chat has
       * going, exactly like a message, and holding the request open across a run
       * would make stopping one depend on it having stopped. The two answers a
       * client can act on come back straight away — a command that does not
       * exist, and arguments that do not fit the schema it rendered from.
       */
      .post(
        '/chat/conversations/:conversationId/commands/:command',
        ({ account, body, params, status }) => {
          const transport = hub.transport;
          if (transport === undefined) return status(503, UNAVAILABLE);

          const rejection = transport.submitCommand({
            arguments: body,
            command: params.command,
            conversationId: params.conversationId,
            senderId: account.accountId,
          });

          switch (rejection?.reason) {
            case undefined:
              return status(202, { command: params.command });
            case 'invalidArguments':
              return status(400, { detail: rejection.detail, error: 'invalid_arguments' });
            case 'unavailable':
              return status(503, UNAVAILABLE);
            case 'unknownCommand':
              return status(404, NO_COMMAND);
          }
        },
        { authenticated: true, body: argumentsSchema, params: commandParamsSchema },
      )

      /**
       * Answers a pending gate request. It is a route and not a message on
       * purpose: "yes" typed into the chat is a word the model reads, and
       * nothing a person says in prose resolves a pending call.
       *
       * A 202 means the answer was handed over, never that it was accepted — the
       * gate still checks that this principal is the one whose run raised the
       * request, and the outcome comes back on the stream like any other.
       */
      .post(
        '/chat/conversations/:conversationId/permissions/:requestId',
        ({ account, body, params, status }) => {
          const transport = hub.transport;
          if (transport === undefined) return status(503, UNAVAILABLE);

          transport.submitDecision({
            conversationId: params.conversationId,
            decision: body.decision,
            requestId: params.requestId,
            scope: body.scope,
            senderId: account.accountId,
          });

          return status(202, { requestId: params.requestId });
        },
        { authenticated: true, body: decisionSchema, params: permissionParamsSchema },
      )
  );
}

/**
 * One subscription rendered as `text/event-stream`. The `type` of the event is
 * the SSE event name and the whole event is its data, so a client may listen by
 * name or read everything off one handler.
 *
 * A stream that cannot be written to is over: the browser is gone, and holding
 * a subscription for it would leak one per closed tab.
 */
function eventStream(
  transport: ChatTransport,
  signal: AbortSignal,
  streamInstanceId: string,
  afterEventId?: number,
): Response {
  const encoder = new TextEncoder();
  /** Assigned as the stream starts; every way of ending it goes through this. */
  let stop: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      stop?.();
    },
    start(controller) {
      let open = true;

      const write = (chunk: string): void => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          stop?.();
        }
      };

      const unsubscribe = transport.subscribe(
        (event: ChatEvent, eventId: number) => {
          write(`id: ${String(eventId)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        },
        { afterEventId },
      );
      const heartbeat = setInterval(() => {
        write(': ping\n\n');
      }, HEARTBEAT_MS);

      const onAbort = (): void => {
        stop?.();
      };

      stop = (): void => {
        if (!open) return;
        open = false;
        clearInterval(heartbeat);
        unsubscribe();
        signal.removeEventListener('abort', onAbort);
        try {
          controller.close();
        } catch {
          // Already closed by the runtime; there is nothing left to release.
        }
      };

      signal.addEventListener('abort', onAbort);
      write(': open\n\n');
    },
  });

  return new Response(stream, {
    headers: {
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'content-type': 'text/event-stream',
      'x-nox-chat-stream-id': streamInstanceId,
      // Nginx buffers a response body by default, which turns a live stream into
      // one delivery at the end of the run.
      'x-accel-buffering': 'no',
    },
  });
}

function requestedEventId(request: Request): number | undefined {
  const value = request.headers.get('last-event-id');
  if (value === null || value.length === 0) return undefined;

  const eventId = Number(value);
  return Number.isSafeInteger(eventId) && eventId >= 0 ? eventId : undefined;
}

function chatRoutes(options: ChatRoutesOptions): ReturnType<typeof createChatRoutes> {
  return createChatRoutes(options);
}

export { chatRoutes };

export type { ChatRoutesOptions };
