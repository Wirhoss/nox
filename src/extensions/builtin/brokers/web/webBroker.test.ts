import { describe, expect, test } from 'bun:test';

import { type ChatEvent, ChatHub } from '../../../../api/chat';
import { silentLogger } from '../../../../logger/logger';
import { testPrincipal } from '../../../../testFixtures';
import { WebBroker } from './webBroker';

import type { BrokerHost, InboundEvent } from '../../../../gateway/broker';
import type { PermissionRequest } from '../../../../tool/gate';

const CONVERSATION = 'nJ8xKqLm2p';

/** The gateway's end of a broker, reduced to what it recorded. */
function testHost(received: InboundEvent[]): BrokerHost {
  return {
    history: () => Promise.resolve(undefined),
    logger: silentLogger,
    receive: (event: InboundEvent): void => {
      received.push(event);
    },
    sessions: () => Promise.resolve([]),
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
  received: InboundEvent[];
  rendered: ChatEvent[];
}> {
  const hub = new ChatHub();
  const broker = new WebBroker(hub);
  const received: InboundEvent[] = [];
  const rendered: ChatEvent[] = [];

  await broker.start(testHost(received));
  broker.subscribe((event) => rendered.push(event));

  return { broker, hub, received, rendered };
}

describe('the web broker', () => {
  test('declares every capability, because this surface can draw all of it', () => {
    const broker = new WebBroker(new ChatHub());

    // A chat service posts text; this one is a UI over the runtime. Deciding
    // what to show is the client's, and nothing is decided for it upstream.
    expect(broker.capabilities).toEqual({
      contextChanges: true,
      permissions: true,
      reasoning: true,
      retries: true,
      runs: true,
      streaming: true,
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
      { conversationId: CONVERSATION, text: 'listo', turnId: 'run-1', type: 'message' },
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

  test('drops an event nobody is watching rather than holding it', async () => {
    const hub = new ChatHub();
    const broker = new WebBroker(hub);
    const rendered: ChatEvent[] = [];
    await broker.start(testHost([]));

    // The transcript already has the reply; this surface has no memory to keep
    // it in, and a closed tab is an ordinary state.
    await broker.deliver({
      conversationId: CONVERSATION,
      text: 'nobody heard this',
      turnId: 'run-1',
      type: 'message',
    });

    broker.subscribe((event) => rendered.push(event));
    await broker.deliver({
      conversationId: CONVERSATION,
      text: 'listo',
      turnId: 'run-2',
      type: 'message',
    });

    // Nothing was replayed to the tab that opened afterwards, and what arrived
    // while it was open reached it.
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({ text: 'listo' });
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
      conversationId: CONVERSATION,
      messageId: 'm-1',
      senderId: 'account-1',
      text: 'hola',
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      conversationId: CONVERSATION,
      messageId: 'm-1',
      senderId: 'account-1',
      text: 'hola',
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
      conversationId: CONVERSATION,
      messageId: 'm-1',
      senderId: 'account-1',
      text: 'hola',
    });

    expect(received).toBeEmpty();
  });
});
