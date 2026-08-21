import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { Agent } from '../agent/agent';
import { NoxApplication } from '../application';
import { GrantAuthorizationProvider } from '../auth/authorization';
import { Database } from '../database/database';
import { ChatProvider } from '../provider/provider';
import { TEST_AUTHORITY, testCatalog } from '../testFixtures';
import { type Tool, ToolSet, type ToolSetGrant } from '../tool/tool';
import { Gateway } from './gateway';

import type { Message, MessageContent } from '../agent/context/message';
import type { ModelConfig, TextGenerateOptions } from '../provider/config';
import type { ProviderSourceEvent } from '../provider/stream';
import type { GatePolicyInput } from '../tool/gate';
import type { Broker, BrokerCapabilities, BrokerHost, OutboundEvent } from './broker';

const MODEL: ModelConfig = { modelId: 'test-model', type: 'text' };

const directories: string[] = [];
const opened: Database[] = [];
const applications: NoxApplication[] = [];

afterEach(async () => {
  for (const application of applications.splice(0)) await application.stop();
  for (const database of opened.splice(0)) await database.close();
  for (const directory of directories.splice(0)) {
    // Windows keeps the SQLite file handle briefly after close(); the temp
    // directory is disposable either way, so a failed unlink is not a failure.
    try {
      rmSync(directory, { force: true, recursive: true });
    } catch {
      /* empty */
    }
  }
});

async function openDatabase(): Promise<Database> {
  const directory = mkdtempSync(join(tmpdir(), 'nox-gateway-'));
  directories.push(directory);
  const database = await Database.open({ path: join(directory, 'nox.db') });
  opened.push(database);
  return database;
}

/** Answers in two fragments, so a streaming broker has something to stream. */
class TwoFragmentProvider extends ChatProvider {
  constructor() {
    super({ baseUrl: 'https://provider.invalid', maxRetries: 0 });
  }

  public override fetchModelIds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  protected override async *attempt(
    _systemPrompt: string,
    _messageHistory: Message[],
    _tools: Tool[],
    _opts: TextGenerateOptions | undefined,
    _signal: AbortSignal,
  ): AsyncIterable<ProviderSourceEvent> {
    yield { text: 'hola ', type: 'textFragment' };
    yield { text: 'mundo', type: 'textFragment' };
    yield { type: 'end' };
  }
}

/** Calls the guarded tool once, then answers. */
class ToolCallingProvider extends ChatProvider {
  constructor() {
    super({ baseUrl: 'https://provider.invalid', maxRetries: 0 });
  }

  public override fetchModelIds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  protected override async *attempt(
    _systemPrompt: string,
    messageHistory: Message[],
    _tools: Tool[],
    _opts: TextGenerateOptions | undefined,
    _signal: AbortSignal,
  ): AsyncIterable<ProviderSourceEvent> {
    if (messageHistory.at(-1)?.role === 'user') {
      yield {
        toolCall: {
          arguments: {},
          name: 'echo',
          role: 'toolCall',
          trackId: `echo-${String(messageHistory.length)}`,
        },
        type: 'toolCall',
      };
    } else {
      yield { text: 'done', type: 'textFragment' };
    }
    yield { type: 'end' };
  }
}

class TestToolSet extends ToolSet {
  readonly #definitions: readonly Tool[];

  constructor(definitions: readonly Tool[]) {
    super('test', 'Tool set used by gateway tests.');
    this.#definitions = definitions;
    this.addTools();
  }

  protected override addTools(): void {
    for (const tool of this.#definitions) this.registerTool(tool);
  }
}

/** A transport that goes nowhere: it records what it is handed and speaks on demand. */
class TestBroker implements Broker {
  public readonly capabilities: BrokerCapabilities;
  public readonly delivered: OutboundEvent[] = [];
  public stopped = false;

  #host?: BrokerHost;
  #messages = 0;

  constructor(capabilities: BrokerCapabilities = {}) {
    this.capabilities = capabilities;
  }

  public deliver(event: OutboundEvent): Promise<void> {
    this.delivered.push(event);
    return Promise.resolve();
  }

  public start(host: BrokerHost): Promise<void> {
    this.#host = host;
    return Promise.resolve();
  }

  public stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }

  /** Someone says something. The id is the transport's own, reused to retry. */
  public say(conversationId: string, text: string, messageId?: string, senderId = 'someone'): void {
    this.#messages += 1;
    this.#host?.receive({
      conversationId,
      messageId: messageId ?? `m${String(this.#messages)}`,
      senderId,
      text,
      type: 'message',
    });
  }

  public answer(
    conversationId: string,
    requestId: string,
    senderId: string,
    resolution: 'denied' | { approved: 'once' | 'session' },
  ): void {
    this.#host?.receive({ conversationId, requestId, resolution, senderId, type: 'permission' });
  }

  public texts(type: OutboundEvent['type']): string[] {
    return this.delivered
      .filter((event) => event.type === type)
      .map((event) => ('text' in event ? event.text : ''));
  }
}

interface Harness {
  application: NoxApplication;
  broker: TestBroker;
  gateway: Gateway;
}

const catalog = testCatalog();

async function harness(
  database: Database,
  broker: TestBroker,
  options: {
    gate?: GatePolicyInput;
    grants?: Readonly<Record<string, readonly string[]>>;
    provider?: ChatProvider;
    toolSets?: readonly ToolSetGrant[];
  } = {},
): Promise<Harness> {
  const application = new NoxApplication();
  applications.push(application);
  await application.start();
  application.addAgent(
    new Agent(database, options.provider ?? new TwoFragmentProvider(), MODEL, {
      agentId: 'assistant',
      authorities: catalog,
      directToolSets: options.toolSets,
      gate: options.gate,
      systemPrompt: 'system',
    }),
  );

  const gateway = new Gateway(application, {
    brokers: [
      {
        agentId: 'assistant',
        authorization: new GrantAuthorizationProvider(
          'test',
          options.grants ?? { someone: ['*'] },
          catalog,
        ),
        broker,
        brokerId: 'test',
      },
    ],
    database,
  });
  application.setGateway(gateway);
  await gateway.start();
  return { application, broker, gateway };
}

/** Waits for one inbound message to become a finished turn. */
async function settle(harnessed: Harness): Promise<void> {
  await harnessed.gateway.drain();
  for (const { session } of harnessed.application.sessions) await session.idle;
}

async function waitFor<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(1);
  }
  throw new Error(`${what} did not appear.`);
}

describe('Gateway', () => {
  test('answers a conversation with the settled reply only', async () => {
    const broker = new TestBroker();
    const harnessed = await harness(await openDatabase(), broker);

    broker.say('chat-1', 'hola');
    await settle(harnessed);

    expect(broker.texts('message')).toEqual(['hola mundo']);
    expect(broker.texts('fragment')).toEqual([]);
    expect(harnessed.application.sessions).toHaveLength(1);
  });

  test('streams to a broker that says it can show a reply being written', async () => {
    const broker = new TestBroker({ streaming: true });
    const harnessed = await harness(await openDatabase(), broker);

    broker.say('chat-1', 'hola');
    await settle(harnessed);

    expect(broker.texts('fragment')).toEqual(['hola ', 'mundo']);
    expect(broker.texts('message')).toEqual(['hola mundo']);

    // Every piece of one reply is one turn, so a broker that edits knows which
    // message it is still writing.
    const turnIds = new Set(broker.delivered.map((event) => event.turnId));
    expect(turnIds.size).toBe(1);
  });

  test('keeps one session per conversation and one conversation per session', async () => {
    const broker = new TestBroker();
    const harnessed = await harness(await openDatabase(), broker);

    broker.say('chat-1', 'primera');
    await settle(harnessed);
    broker.say('chat-1', 'segunda');
    await settle(harnessed);
    broker.say('chat-2', 'otra');
    await settle(harnessed);

    const sessions = harnessed.application.sessions;
    expect(sessions).toHaveLength(2);

    const first = sessions.find((live) => live.session.getTranscript().length > 2);
    expect(
      first?.session.getTranscript().filter((message) => message.role === 'user'),
    ).toHaveLength(2);
  });

  test('reopens the same session when the same chat speaks after a restart', async () => {
    const database = await openDatabase();
    const before = new TestBroker();
    const first = await harness(database, before);

    before.say('chat-1', 'primera');
    await settle(first);
    const sessionId = first.application.sessions[0]?.session.sessionId;
    expect(sessionId).toBeString();
    await first.application.stop();

    const after = new TestBroker();
    const second = await harness(database, after);
    after.say('chat-1', 'segunda');
    await settle(second);

    const resumed = second.application.sessions[0]?.session;
    expect(resumed?.sessionId).toBe(sessionId);
    // The transcript is the one that chat already had, not a new one.
    expect(resumed?.getTranscript().filter((message) => message.role === 'user')).toHaveLength(2);
  });

  test('drops a delivery the transport already made', async () => {
    const broker = new TestBroker();
    const harnessed = await harness(await openDatabase(), broker);

    broker.say('chat-1', 'hola', 'same-id');
    await settle(harnessed);
    broker.say('chat-1', 'hola', 'same-id');
    await settle(harnessed);

    expect(broker.texts('message')).toEqual(['hola mundo']);
    const session = harnessed.application.sessions[0]?.session;
    expect(session?.getTranscript().filter((message) => message.role === 'user')).toHaveLength(1);
  });

  test('silences the transports on stop and ignores what arrives after', async () => {
    const broker = new TestBroker();
    const harnessed = await harness(await openDatabase(), broker);

    await harnessed.application.stop();
    expect(broker.stopped).toBeTrue();

    broker.say('chat-1', 'hola');
    await harnessed.gateway.drain();
    expect(broker.delivered).toEqual([]);
  });

  describe('permissions', () => {
    function guardedTool(executions: { count: number }): Tool {
      return {
        authority: TEST_AUTHORITY,
        description: 'echoes',
        name: 'echo',
        parameters: z.object({}),
        prepare: () => ({
          run: (): Promise<MessageContent[]> => {
            executions.count += 1;
            return Promise.resolve([{ text: 'echoed', type: 'text' }]);
          },
          title: 'Echo a value',
          type: 'immediate' as const,
        }),
      };
    }

    async function guarded(
      broker: TestBroker,
      grants?: Readonly<Record<string, readonly string[]>>,
    ): Promise<{ executions: { count: number }; harnessed: Harness }> {
      const executions = { count: 0 };
      const harnessed = await harness(await openDatabase(), broker, {
        gate: {
          defaultVerdict: 'allow',
          escalationTimeoutMs: 10_000,
          rules: [{ reason: 'needs a human', tools: ['echo'], verdict: 'escalate' }],
        },
        grants,
        provider: new ToolCallingProvider(),
        toolSets: [{ toolSet: new TestToolSet([guardedTool(executions)]), toolSetId: 'direct' }],
      });
      return { executions, harnessed };
    }

    test('asks the conversation and runs the tool once the originator answers', async () => {
      const broker = new TestBroker({ permissions: true, streaming: false });
      const { executions, harnessed } = await guarded(broker, { alice: ['*'] });

      broker.say('chat-1', 'usa echo', undefined, 'alice');
      const asked = await waitFor(
        () => broker.delivered.find((event) => event.type === 'permission'),
        'A permission request',
      );
      expect(executions.count).toBe(0);
      expect(asked.request.toolName).toBe('echo');
      expect(asked.request.runAuthority.principal).toEqual({ issuer: 'test', subject: 'alice' });

      // Anyone but the principal whose run asked is a bystander, whatever the
      // transport says and whatever else they are allowed to do themselves.
      broker.answer('chat-1', asked.request.requestId, 'bob', 'denied');
      await harnessed.gateway.drain();
      expect(harnessed.application.sessions[0]?.session.getPendingPermissions()).toHaveLength(1);

      broker.answer('chat-1', asked.request.requestId, 'alice', { approved: 'once' });
      await settle(harnessed);

      expect(executions.count).toBe(1);
      expect(broker.delivered.some((event) => event.type === 'permissionResolved')).toBeTrue();
      expect(broker.texts('message')).toEqual(['done']);
    });

    test('never lets prose in the conversation resolve a pending call', async () => {
      const broker = new TestBroker({ permissions: true, streaming: false });
      const { executions, harnessed } = await guarded(broker, { alice: ['*'] });

      broker.say('chat-1', 'usa echo', undefined, 'alice');
      await waitFor(
        () => broker.delivered.find((event) => event.type === 'permission'),
        'A permission request',
      );

      for (const text of ['approve', 'sí, dale', 'yes']) {
        broker.say('chat-1', text, `answer-${text}`, 'alice');
      }
      await harnessed.gateway.drain();

      expect(harnessed.application.sessions[0]?.session.getPendingPermissions()).toHaveLength(1);
      expect(executions.count).toBe(0);
    });

    test('does not ask a transport that cannot put a question to a human', async () => {
      const broker = new TestBroker({ permissions: false });
      const { executions, harnessed } = await guarded(broker, { alice: ['*'] });

      broker.say('chat-1', 'usa echo', undefined, 'alice');
      await waitFor(
        () => harnessed.application.sessions[0]?.session.getPendingPermissions()[0],
        'A pending permission',
      );

      expect(broker.delivered.filter((event) => event.type === 'permission')).toEqual([]);
      expect(executions.count).toBe(0);
    });

    test('denies a principal without the grant before the gate ever asks', async () => {
      const broker = new TestBroker({ permissions: true, streaming: false });
      const { executions, harnessed } = await guarded(broker, { alice: ['nox.history.*'] });

      broker.say('chat-1', 'usa echo', undefined, 'alice');
      await settle(harnessed);

      expect(executions.count).toBe(0);
      expect(broker.delivered.filter((event) => event.type === 'permission')).toEqual([]);
      expect(harnessed.application.sessions[0]?.session.getPendingPermissions()).toEqual([]);
    });
  });
});
