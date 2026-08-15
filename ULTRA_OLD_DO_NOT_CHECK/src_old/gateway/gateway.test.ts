import { describe, expect, test } from 'bun:test';

import { EventLog } from '../utils';

import { BaseBroker } from './broker';
import { MessageGateway } from './gateway';

import type { AgentStreamEvent } from '../agent/runner';
import type { PendingEscalation } from '../gate';
import type { Message } from '../provider';
import type { GatewaySession } from './dispatcher';
import type { SessionEventEnvelope } from './events';
import type { SessionResolver } from './gateway';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeSession implements GatewaySession {
  public readonly log = new EventLog<AgentStreamEvent>();
  public runs: string[] = [];
  public steers: string[] = [];

  public get eventCursor(): number { return this.log.length; }
  public get history(): readonly Message[] { return []; }
  public get idle(): Promise<void> { return Promise.resolve(); }
  public get isRunning(): boolean { return false; }

  public permissionReplies: Array<{ approved: boolean; requestId: string }> = [];
  public aborts = 0;

  public async abort(): Promise<boolean> {
    this.aborts++;
    return false;
  }

  public listPendingPermissions(): PendingEscalation[] {
    return [];
  }

  public resolvePermission(requestId: string, approved: boolean): boolean {
    this.permissionReplies.push({ approved, requestId });
    return true;
  }

  public async run(text: string): Promise<void> {
    this.runs.push(text);
  }

  public async steer(text: string): Promise<void> {
    this.steers.push(text);
  }

  public subscribeToEvents(from = 0): AsyncGenerator<AgentStreamEvent> {
    return this.log.subscribe(from);
  }
}

class FakeBroker extends BaseBroker {
  public readonly delivery = 'messages';
  public delivered: SessionEventEnvelope[] = [];

  public async start(): Promise<void> {}
  public async stop(): Promise<void> {}

  public async deliver(_conversationId: string, envelope: SessionEventEnvelope): Promise<void> {
    this.delivered.push(envelope);
  }
}

function setup(): { broker: FakeBroker; gateway: MessageGateway; session: FakeSession } {
  const session = new FakeSession();
  const sessions = new Map<string, FakeSession>();
  let counter = 0;
  const resolver: SessionResolver = {
    createSession: (_blueprintId: string) => {
      const sessionId = `session-${++counter}`;
      sessions.set(sessionId, session);
      return { session, sessionId };
    },
    restoreSession: (sessionId: string) => {
      const restored = sessions.get(sessionId);
      if (!restored) throw new Error(`Session with id ${sessionId} not found.`);
      return restored;
    },
    deleteSession: async (sessionId: string) => {
      if (!sessions.delete(sessionId)) throw new Error(`Session with id ${sessionId} not found.`);
    },
  };
  const gateway = new MessageGateway(resolver);
  const broker = new FakeBroker({ defaultBlueprintId: 'default', debounceMs: 5 });
  return { broker, gateway, session };
}

const assistantMessage: Message = { role: 'assistant', content: [{ type: 'text', text: 'hola' }] };

describe('MessageGateway', () => {
  test('broker inbox routes chat envelopes into the bound session', async () => {
    const { broker, gateway, session } = setup();
    const inbox = gateway.createInbox('fake', broker);

    const { sessionId } = inbox.openConversation('conv-1');
    expect(sessionId).toBe('session-1');
    inbox.submit('conv-1', { kind: 'chat', text: 'hola nox' });
    await sleep(30);

    expect(session.runs).toEqual(['hola nox']);
  });

  test('submitting to an unbound conversation throws', () => {
    const { broker, gateway } = setup();
    const inbox = gateway.createInbox('fake', broker);

    expect(() => inbox.submit('nope', { kind: 'chat', text: 'x' })).toThrow('No session bound');
  });

  test('unknown control actions are dropped without reaching the session', async () => {
    const { broker, gateway, session } = setup();
    const inbox = gateway.createInbox('fake', broker);

    inbox.openConversation('conv-1');
    inbox.submit('conv-1', { kind: 'control', action: 'selfDestruct' });
    await sleep(20);

    expect(session.runs).toEqual([]);
    expect(session.permissionReplies).toEqual([]);
  });

  test('permissionReply control envelopes resolve the session escalation', () => {
    const { broker, gateway, session } = setup();
    const inbox = gateway.createInbox('fake', broker);

    inbox.openConversation('conv-1');
    inbox.submit('conv-1', {
      kind: 'control',
      action: 'permissionReply',
      payload: { requestId: 'req-1', approved: true },
    });

    expect(session.permissionReplies).toEqual([{ approved: true, requestId: 'req-1' }]);
    expect(session.runs).toEqual([]);
  });

  test('malformed permissionReply payloads are dropped', () => {
    const { broker, gateway, session } = setup();
    const inbox = gateway.createInbox('fake', broker);

    inbox.openConversation('conv-1');
    inbox.submit('conv-1', { kind: 'control', action: 'permissionReply', payload: { requestId: 42 } });

    expect(session.permissionReplies).toEqual([]);
  });

  test('coarse brokers only receive whole assistant messages and errors', async () => {
    const { broker, gateway, session } = setup();
    const inbox = gateway.createInbox('fake', broker);

    inbox.openConversation('conv-1');
    session.log.push({ type: 'assistantReasoningFragment', text: 'thinking' });
    session.log.push({ type: 'assistantTextFragment', text: 'ho' });
    session.log.push({ type: 'message', message: assistantMessage });
    session.log.push({ type: 'error', error: new Error('se rompió') });
    session.log.close();
    await sleep(20);

    expect(broker.delivered.map((envelope) => envelope.cursor)).toEqual([2, 3]);
    expect(broker.delivered[0]?.event).toEqual({ type: 'message', message: assistantMessage });
    expect(broker.delivered[1]?.event).toEqual({ type: 'error', message: 'se rompió' });
  });

  test('sendMessage queues through the dispatcher and reports delivery', async () => {
    const { gateway, session } = setup();
    const { sessionId } = gateway.createSession('default');

    const { delivery } = gateway.sendMessage(sessionId, 'hey');
    await sleep(320);

    expect(delivery).toBe('queued');
    expect(session.runs).toEqual(['hey']);
  });

  test('abortRun drops the queued backlog and aborts the session', async () => {
    const { gateway, session } = setup();
    const { sessionId } = gateway.createSession('default');

    gateway.sendMessage(sessionId, 'nunca corras');
    const { aborted } = await gateway.abortRun(sessionId);
    await sleep(350);

    expect(aborted).toBe(false);
    expect(session.aborts).toBe(1);
    expect(session.runs).toEqual([]);
  });

  test('deleteSession removes bindings and the stored session', async () => {
    const { broker, gateway } = setup();
    const inbox = gateway.createInbox('fake', broker);
    const { sessionId } = inbox.openConversation('conv-1');

    await gateway.deleteSession(sessionId);

    expect(() => gateway.sendMessage(sessionId, 'x')).toThrow('not found');
    expect(() => inbox.submit('conv-1', { kind: 'chat', text: 'x' })).toThrow('No session bound');
    await expect(gateway.deleteSession(sessionId)).rejects.toThrow('not found');
  });

  test('subscribe yields serialized events with cursors', async () => {
    const { gateway, session } = setup();
    const { sessionId } = gateway.createSession('default');

    session.log.push({ type: 'message', message: assistantMessage });
    session.log.push({ type: 'error', error: new Error('x') });
    session.log.close();

    const received: SessionEventEnvelope[] = [];
    for await (const envelope of gateway.subscribe(sessionId)) {
      received.push(envelope);
    }

    expect(received).toEqual([
      { cursor: 0, event: { type: 'message', message: assistantMessage } },
      { cursor: 1, event: { type: 'error', message: 'x' } },
    ]);
  });

  test('a stale cursor from a previous process replays the current event log', async () => {
    const { gateway, session } = setup();
    const { sessionId } = gateway.createSession('default');
    session.log.push({ type: 'message', message: assistantMessage });

    const stream = gateway.subscribe(sessionId, 99);
    const first = await stream.next();

    expect(first.value).toEqual({
      cursor: 0,
      event: { type: 'message', message: assistantMessage },
    });
    await stream.return(undefined);
  });
});
