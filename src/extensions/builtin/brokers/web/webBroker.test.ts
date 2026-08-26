import { describe, expect, test } from 'bun:test';

import { type ChatEvent, ChatHub } from '../../../../api/chat';
import { silentLogger } from '../../../../logger/logger';
import { testPrincipal } from '../../../../testFixtures';
import { WebBroker } from './webBroker';

import type {
  BrokerHistory,
  BrokerHost,
  BrokerSession,
  InboundEvent,
} from '../../../../gateway/broker';
import type {
  BrokerCommandSpec,
  CommandInvocation,
  CommandRejection,
} from '../../../../gateway/command';
import type { PermissionRequest } from '../../../../tool/gate';

const CONVERSATION = 'nJ8xKqLm2p';

/** What a gateway would answer with, for the tests that ask it something. */
interface HostAnswers {
  asked?: { conversationId: string; limit?: number }[];
  /** The catalog the gateway publishes, as opposed to what was invoked from it. */
  commands?: readonly BrokerCommandSpec[];
  history?: BrokerHistory;
  invoked?: CommandInvocation[];
  rejection?: CommandRejection;
  sessions?: readonly BrokerSession[];
}

/** The gateway's end of a broker, reduced to what it recorded and what it answers. */
function testHost(received: InboundEvent[], answers: HostAnswers = {}): BrokerHost {
  return {
    agentIds: () => ['nox'],
    command: (invocation) => {
      answers.invoked?.push(invocation);
      return answers.rejection;
    },
    commands: answers.commands ?? [],
    history: (conversationId, options) => {
      answers.asked?.push({ conversationId, limit: options?.limit });
      return Promise.resolve(answers.history);
    },
    logger: silentLogger,
    receive: (event: InboundEvent) => {
      received.push(event);
      return undefined;
    },
    sessions: () => Promise.resolve(answers.sessions ?? []),
    signal: new AbortController().signal,
  };
}

function pendingPermission(): PermissionRequest {
  return {
    authority: 'nox.test.tool',
    expiresAt: new Date('2026-01-01T00:05:00.000Z'),
    params: { to: 'maria@example.com' },
    preview: 'Confirmo nuestra reunión del viernes',
    reason: 'External communication needs an answer.',
    requestId: 'request-1',
    requestedAt: new Date('2026-01-01T00:00:00.000Z'),
    risk: { effects: ['network'], reversible: false },
    runAuthority: { principal: testPrincipal(), source: { messageId: 'm-1', type: 'message' } },
    runId: 'run-1',
    sessionId: 'session-1',
    signals: [{ code: 'external', reason: 'Leaves the machine.', severity: 'approval' }],
    title: 'send_email',
    toolName: 'send_email',
    toolSetId: 'mail',
    trackId: 'track-1',
  };
}

/** A started broker, everything it emitted, and everything the gateway was told. */
async function startedBroker(): Promise<{
  broker: WebBroker;
  hub: ChatHub;
  invoked: CommandInvocation[];
  received: InboundEvent[];
  rendered: ChatEvent[];
}> {
  const hub = new ChatHub();
  const broker = new WebBroker(hub);
  const invoked: CommandInvocation[] = [];
  const received: InboundEvent[] = [];
  const rendered: ChatEvent[] = [];

  await broker.start(testHost(received, { invoked }));
  broker.subscribe((event) => rendered.push(event));

  return { broker, hub, invoked, received, rendered };
}

describe('the web broker', () => {
  test('declares every capability, because this surface can draw all of it', () => {
    const broker = new WebBroker(new ChatHub());

    // A chat service posts text; this one is a UI over the runtime. Deciding
    // what to show is the client's, and nothing is decided for it upstream.
    expect(broker.capabilities).toEqual({
      contextChanges: true,
      contextUsage: true,
      permissions: true,
      reasoning: true,
      retries: true,
      runs: true,
      streaming: true,
      titles: true,
      toolActivity: true,
      usage: true,
    });
  });

  test('claims the surface while it runs, and lets go when it stops', async () => {
    const hub = new ChatHub();
    const broker = new WebBroker(hub);

    expect(hub.transport).toBeUndefined();

    await broker.start(testHost([]));
    expect(hub.transport).toBe(broker);

    await broker.stop();
    expect(hub.transport).toBeUndefined();
  });

  test('renders text events as they are, addressed to their turn', async () => {
    const { broker, rendered } = await startedBroker();

    await broker.deliver({
      conversationId: CONVERSATION,
      text: 'lis',
      turnId: 'run-1',
      type: 'fragment',
    });
    await broker.deliver({
      content: [{ text: 'listo', type: 'text' }],
      conversationId: CONVERSATION,
      text: 'listo',
      turnId: 'run-1',
      type: 'message',
    });
    await broker.deliver({
      conversationId: CONVERSATION,
      text: 'the provider refused',
      turnId: 'run-1',
      type: 'error',
    });

    expect(rendered).toEqual([
      { conversationId: CONVERSATION, text: 'lis', turnId: 'run-1', type: 'fragment' },
      {
        content: [{ text: 'listo', type: 'text' }],
        conversationId: CONVERSATION,
        text: 'listo',
        turnId: 'run-1',
        type: 'message',
      },
      {
        conversationId: CONVERSATION,
        text: 'the provider refused',
        turnId: 'run-1',
        type: 'error',
      },
    ]);
  });

  test('sends a permission request as dates a browser can read, and nothing internal', async () => {
    const { broker, rendered } = await startedBroker();

    await broker.deliver({
      conversationId: CONVERSATION,
      request: pendingPermission(),
      turnId: 'run-1',
      type: 'permission',
    });

    const [event] = rendered;
    if (event?.type !== 'permission') throw new Error('Expected a permission event.');

    expect(event.request).toEqual({
      authority: 'nox.test.tool',
      expiresAt: '2026-01-01T00:05:00.000Z',
      params: { to: 'maria@example.com' },
      preview: 'Confirmo nuestra reunión del viernes',
      reason: 'External communication needs an answer.',
      requestId: 'request-1',
      requestedAt: '2026-01-01T00:00:00.000Z',
      risk: { effects: ['network'], reversible: false },
      runId: 'run-1',
      sessionId: 'session-1',
      signals: [{ code: 'external', reason: 'Leaves the machine.', severity: 'approval' }],
      title: 'send_email',
      toolName: 'send_email',
      toolSetId: 'mail',
    });
    // Who may approve was settled before this was sent, and the track a call sits
    // on means nothing outside a run.
    expect(event.request).not.toContainKey('runAuthority');
    expect(event.request).not.toContainKey('trackId');
  });

  test('flattens how a request ended, so a client narrows once', async () => {
    const { broker, rendered } = await startedBroker();

    await broker.deliver({
      conversationId: CONVERSATION,
      requestId: 'request-1',
      resolution: { resolution: 'approved', scope: 'session' },
      turnId: 'run-1',
      type: 'permissionResolved',
    });
    await broker.deliver({
      conversationId: CONVERSATION,
      requestId: 'request-2',
      resolution: { resolution: 'timeout' },
      turnId: 'run-1',
      type: 'permissionResolved',
    });

    expect(
      rendered.map((event) => (event.type === 'permissionResolved' ? event.outcome : undefined)),
    ).toEqual([{ resolution: 'approved', scope: 'session' }, { resolution: 'timeout' }]);
  });

  test('does not replay settled traffic to a fresh page', async () => {
    const hub = new ChatHub();
    const broker = new WebBroker(hub);
    const rendered: ChatEvent[] = [];
    await broker.start(testHost([]));

    await broker.deliver({
      content: [{ text: 'already durable', type: 'text' }],
      conversationId: CONVERSATION,
      text: 'already durable',
      turnId: 'run-1',
      type: 'message',
    });

    broker.subscribe((event) => rendered.push(event));
    await broker.deliver({
      content: [{ text: 'listo', type: 'text' }],
      conversationId: CONVERSATION,
      text: 'listo',
      turnId: 'run-2',
      type: 'message',
    });

    // A new page reads settled messages from history; only live traffic and an
    // unfinished run are replayed by the stream.
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({ text: 'listo' });
  });

  test('replays an unfinished run to a page that opens while text is streaming', async () => {
    const hub = new ChatHub();
    const broker = new WebBroker(hub);
    const rendered: ChatEvent[] = [];
    await broker.start(testHost([]));

    await broker.deliver({
      conversationId: CONVERSATION,
      modelId: 'gpt-test',
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      trigger: 'user',
      turnId: 'run-live',
      type: 'runStarted',
    });
    await broker.deliver({
      conversationId: CONVERSATION,
      text: 'texto antes de recargar',
      turnId: 'run-live',
      type: 'fragment',
    });

    broker.subscribe((event) => rendered.push(event));

    expect(rendered.map((event) => event.type)).toEqual(['runStarted', 'fragment']);
    expect(rendered[1]).toMatchObject({ text: 'texto antes de recargar' });
  });

  test('resumes from a cursor even when the run completed while disconnected', async () => {
    const hub = new ChatHub();
    const broker = new WebBroker(hub);
    const received: { event: ChatEvent; eventId: number }[] = [];
    await broker.start(testHost([]));
    const unsubscribe = broker.subscribe((event, eventId) => received.push({ event, eventId }));

    await broker.deliver({
      conversationId: CONVERSATION,
      modelId: 'gpt-test',
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      trigger: 'user',
      turnId: 'run-resume',
      type: 'runStarted',
    });
    await broker.deliver({
      conversationId: CONVERSATION,
      text: 'before ',
      turnId: 'run-resume',
      type: 'fragment',
    });
    const cursor = received[received.length - 1]?.eventId;
    if (cursor === undefined) throw new Error('Expected a delivered event cursor.');
    unsubscribe();

    await broker.deliver({
      conversationId: CONVERSATION,
      text: 'disconnect',
      turnId: 'run-resume',
      type: 'fragment',
    });
    await broker.deliver({
      content: [{ text: 'before disconnect', type: 'text' }],
      conversationId: CONVERSATION,
      text: 'before disconnect',
      turnId: 'run-resume',
      type: 'message',
    });
    await broker.deliver({
      conversationId: CONVERSATION,
      durationMs: 100,
      status: 'completed',
      turnId: 'run-resume',
      type: 'runCompleted',
      usage: { inputTokens: 1, outputTokens: 2 },
    });

    const resumed: ChatEvent[] = [];
    broker.subscribe((event) => resumed.push(event), { afterEventId: cursor });
    const fresh: ChatEvent[] = [];
    broker.subscribe((event) => fresh.push(event));

    expect(resumed.map((event) => event.type)).toEqual(['fragment', 'message', 'runCompleted']);
    expect(fresh).toBeEmpty();
  });

  test('renders reasoning as its own kind, live and settled', async () => {
    const { broker, rendered } = await startedBroker();

    await broker.deliver({
      conversationId: CONVERSATION,
      text: 'pien',
      turnId: 'run-1',
      type: 'reasoningFragment',
    });
    await broker.deliver({
      conversationId: CONVERSATION,
      text: 'pienso un poco',
      turnId: 'run-1',
      type: 'reasoning',
    });

    // Never folded into the reply: a client that shows thinking in a panel it
    // can fold away must be able to tell the two apart.
    expect(rendered.map((event) => event.type)).toEqual(['reasoningFragment', 'reasoning']);
  });

  test('renders tool activity with the arguments the agent actually sent', async () => {
    const { broker, rendered } = await startedBroker();

    await broker.deliver({
      arguments: { to: 'maria@example.com' },
      conversationId: CONVERSATION,
      name: 'send_email',
      trackId: 'track-1',
      turnId: 'run-1',
      type: 'toolCall',
    });
    await broker.deliver({
      content: [{ text: 'sent', type: 'text' }],
      conversationId: CONVERSATION,
      execution: 'immediate',
      isError: false,
      name: 'send_email',
      text: 'sent',
      trackId: 'track-1',
      turnId: 'run-1',
      type: 'toolResponse',
    });

    expect(rendered).toEqual([
      {
        arguments: { to: 'maria@example.com' },
        conversationId: CONVERSATION,
        name: 'send_email',
        trackId: 'track-1',
        turnId: 'run-1',
        type: 'toolCall',
      },
      {
        content: [{ text: 'sent', type: 'text' }],
        conversationId: CONVERSATION,
        execution: 'immediate',
        isError: false,
        name: 'send_email',
        text: 'sent',
        trackId: 'track-1',
        turnId: 'run-1',
        type: 'toolResponse',
      },
    ]);
  });

  test('sends the run lifecycle with a date a browser can read', async () => {
    const { broker, rendered } = await startedBroker();

    await broker.deliver({
      conversationId: CONVERSATION,
      modelId: 'gpt-test',
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      trigger: 'user',
      turnId: 'run-1',
      type: 'runStarted',
    });
    await broker.deliver({
      conversationId: CONVERSATION,
      durationMs: 1400,
      status: 'maxIterations',
      turnId: 'run-1',
      type: 'runCompleted',
      usage: { inputTokens: 3, outputTokens: 5 },
    });

    expect(rendered[0]).toEqual({
      conversationId: CONVERSATION,
      modelId: 'gpt-test',
      startedAt: '2026-01-01T00:00:00.000Z',
      trigger: 'user',
      turnId: 'run-1',
      type: 'runStarted',
    });
    // The status is the part a client cannot infer from the text: an answer that
    // stopped at the iteration ceiling is probably truncated.
    expect(rendered[1]).toMatchObject({ status: 'maxIterations', usage: { outputTokens: 5 } });
  });

  test('says what the context replaced, and what it replaced it with', async () => {
    const { broker, rendered } = await startedBroker();

    await broker.deliver({
      change: 'compacted',
      conversationId: CONVERSATION,
      replacedMessageIds: ['m-1', 'm-2'],
      text: 'summary of the first hour',
      turnId: 'run-1',
      type: 'contextChange',
    });

    expect(rendered[0]).toEqual({
      change: 'compacted',
      conversationId: CONVERSATION,
      replacedMessageIds: ['m-1', 'm-2'],
      text: 'summary of the first hour',
      turnId: 'run-1',
      type: 'contextChange',
    });
  });

  test('renders the runtime context accounting without recomputing it', async () => {
    const { broker, rendered } = await startedBroker();

    await broker.deliver({
      conversationId: CONVERSATION,
      turnId: 'run-1',
      type: 'contextUsage',
      usage: { compactAtTokens: 6_400, contextWindow: 10_000, usedTokens: 3_200 },
    });

    expect(rendered[0]).toEqual({
      conversationId: CONVERSATION,
      turnId: 'run-1',
      type: 'contextUsage',
      usage: { compactAtTokens: 6_400, contextWindow: 10_000, usedTokens: 3_200 },
    });
  });

  test('passes a retry through as something that has not failed yet', async () => {
    const { broker, rendered } = await startedBroker();

    await broker.deliver({
      attempt: 2,
      conversationId: CONVERSATION,
      delayMs: 500,
      text: 'upstream timed out',
      turnId: 'run-1',
      type: 'retry',
    });
    await broker.deliver({
      conversationId: CONVERSATION,
      turnId: 'run-1',
      type: 'usage',
      usage: { inputTokens: 3, outputTokens: 5 },
    });

    expect(rendered[0]).toMatchObject({ attempt: 2, delayMs: 500, text: 'upstream timed out' });
    expect(rendered[1]).toMatchObject({ type: 'usage', usage: { inputTokens: 3 } });
  });

  test('hands a message to the gateway as the sender the surface authenticated', async () => {
    const { broker, received } = await startedBroker();

    broker.submitMessage({
      content: [{ text: 'hola', type: 'text' }],
      conversationId: CONVERSATION,
      messageId: 'm-1',
      senderId: 'account-1',
      text: 'hola',
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      content: [{ text: 'hola', type: 'text' }],
      conversationId: CONVERSATION,
      messageId: 'm-1',
      senderId: 'account-1',
      type: 'message',
    });
  });

  test('narrows an approval that named no scope to this call alone', async () => {
    const { broker, received } = await startedBroker();

    broker.submitDecision({
      conversationId: CONVERSATION,
      decision: 'approve',
      requestId: 'request-1',
      senderId: 'account-1',
    });
    broker.submitDecision({
      conversationId: CONVERSATION,
      decision: 'approve',
      requestId: 'request-2',
      scope: 'session',
      senderId: 'account-1',
    });
    broker.submitDecision({
      conversationId: CONVERSATION,
      decision: 'deny',
      requestId: 'request-3',
      senderId: 'account-1',
    });

    expect(
      received.map((event) => (event.type === 'permission' ? event.resolution : undefined)),
    ).toEqual([{ approved: 'once' }, { approved: 'session' }, 'denied']);
  });

  test('says nothing to a gateway it no longer has', async () => {
    const { broker, received } = await startedBroker();
    await broker.stop();

    broker.submitMessage({
      content: [{ text: 'hola', type: 'text' }],
      conversationId: CONVERSATION,
      messageId: 'm-1',
      senderId: 'account-1',
      text: 'hola',
    });

    expect(received).toBeEmpty();
  });

  test('hands a steer over as a steer, not as a message', async () => {
    const { broker, received } = await startedBroker();

    broker.submitSteer({
      content: [{ text: 'mejor no', type: 'text' }],
      conversationId: CONVERSATION,
      messageId: 'm-1',
      senderId: 'account-1',
      text: 'mejor no',
    });

    // Steering and ordinary speech reach the gateway the same way, but the
    // explicit intent stays on the event and is never inferred from the words.
    expect(received[0]).toMatchObject({
      content: [{ text: 'mejor no', type: 'text' }],
      conversationId: CONVERSATION,
      messageId: 'm-1',
      senderId: 'account-1',
      type: 'steer',
    });
  });

  test('passes the command catalog through rather than curating it', async () => {
    const commands: readonly BrokerCommandSpec[] = [
      { description: 'Stops the agent.', name: 'stop', parameters: { type: 'object' } },
      { description: 'Tags it.', name: 'tag', parameters: { type: 'object' } },
    ];
    const broker = new WebBroker(new ChatHub());
    await broker.start(testHost([], { commands }));

    // What a client draws from them is the client's decision; deciding upstream
    // which commands a browser deserves would be product design for it.
    expect(broker.listCommands()).toEqual(commands);
  });

  test('hands an invocation over untouched and returns what came back', async () => {
    const { broker, invoked } = await startedBroker();

    const accepted = broker.submitCommand({
      arguments: { tags: ['urgent', 'done'] },
      command: 'tag',
      conversationId: CONVERSATION,
      senderId: 'account-1',
    });

    expect(accepted).toBeUndefined();
    // Arguments cross as they arrived: whether they fit is the catalog's
    // question, and a transport that pre-judged it would be a second definition
    // of the same command.
    expect(invoked).toEqual([
      {
        arguments: { tags: ['urgent', 'done'] },
        command: 'tag',
        conversationId: CONVERSATION,
        senderId: 'account-1',
      },
    ]);
  });

  test('reports a refusal back to whoever asked', async () => {
    const broker = new WebBroker(new ChatHub());
    await broker.start(testHost([], { rejection: { reason: 'unknownCommand' } }));

    expect(
      broker.submitCommand({
        command: 'selfDestruct',
        conversationId: CONVERSATION,
        senderId: 'account-1',
      }),
    ).toEqual({ reason: 'unknownCommand' });
  });

  test('reads a conversation back in the vocabulary the stream speaks', async () => {
    const asked: { conversationId: string; limit?: number }[] = [];
    const hub = new ChatHub();
    const broker = new WebBroker(hub);
    await broker.start(
      testHost([], {
        asked,
        history: {
          agentId: 'assistant',
          contextUsage: { compactAtTokens: 6_400, contextWindow: 10_000, usedTokens: 3_200 },
          conversationId: CONVERSATION,
          entries: [
            {
              at: new Date('2026-01-01T00:00:00.000Z'),
              content: [{ text: 'hola', type: 'text' }],
              messageId: 'm-1',
              mode: 'steer',
              principal: { issuer: 'web', subject: 'account-1' },
              text: 'hola',
              type: 'userMessage',
            },
            {
              at: new Date('2026-01-01T00:00:01.000Z'),
              content: [{ text: 'hola mundo', type: 'text' }],
              messageId: 'm-2',
              text: 'hola mundo',
              type: 'message',
            },
            {
              arguments: { value: 'x' },
              at: new Date('2026-01-01T00:00:02.000Z'),
              messageId: 'm-3',
              name: 'echo',
              trackId: 'echo-1',
              type: 'toolCall',
            },
          ],
          sessionId: 'session-1',
        },
      }),
    );

    const history = await broker.readHistory({ conversationId: CONVERSATION, limit: 3 });

    expect(asked).toEqual([{ conversationId: CONVERSATION, limit: 3 }]);
    expect(history?.contextUsage).toEqual({
      compactAtTokens: 6_400,
      contextWindow: 10_000,
      usedTokens: 3_200,
    });
    // A `Date` does not survive the wire, and a client redrawing a conversation
    // reads the same shapes it reads off the stream.
    expect(history?.entries).toEqual([
      {
        at: '2026-01-01T00:00:00.000Z',
        content: [{ text: 'hola', type: 'text' }],
        messageId: 'm-1',
        mode: 'steer',
        principal: { issuer: 'web', subject: 'account-1' },
        text: 'hola',
        type: 'userMessage',
      },
      {
        at: '2026-01-01T00:00:01.000Z',
        content: [{ text: 'hola mundo', type: 'text' }],
        messageId: 'm-2',
        text: 'hola mundo',
        type: 'message',
      },
      {
        arguments: { value: 'x' },
        at: '2026-01-01T00:00:02.000Z',
        messageId: 'm-3',
        name: 'echo',
        trackId: 'echo-1',
        type: 'toolCall',
      },
    ]);
  });

  test('lists what the gateway says it carries, dates and all', async () => {
    const hub = new ChatHub();
    const broker = new WebBroker(hub);
    await broker.start(
      testHost([], {
        sessions: [
          {
            agentId: 'assistant',
            contextUsage: { contextWindow: 10_000, usedTokens: 3_200 },
            conversationId: CONVERSATION,
            sessionId: 'session-1',
            startedAt: new Date('2026-01-01T00:00:00.000Z'),
            state: 'closed',
            updatedAt: new Date('2026-01-02T00:00:00.000Z'),
          },
        ],
      }),
    );

    expect(await broker.listConversations()).toEqual([
      {
        agentId: 'assistant',
        contextUsage: { contextWindow: 10_000, usedTokens: 3_200 },
        conversationId: CONVERSATION,
        sessionId: 'session-1',
        startedAt: '2026-01-01T00:00:00.000Z',
        state: 'closed',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ]);
  });

  test('has nothing to answer once it no longer has a gateway', async () => {
    const { broker } = await startedBroker();
    await broker.stop();

    expect(await broker.readHistory({ conversationId: CONVERSATION })).toBeUndefined();
    expect(await broker.listConversations()).toEqual([]);
    expect(broker.listCommands()).toEqual([]);
    // Not silently dropped: a command is the one thing a transport gets an
    // answer to, so "there is no gateway" is an answer it has to give.
    expect(
      broker.submitCommand({
        command: 'stop',
        conversationId: CONVERSATION,
        senderId: 'account-1',
      }),
    ).toEqual({ reason: 'unavailable' });
  });
});
