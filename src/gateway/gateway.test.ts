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
import { brokerCommand, type BrokerCommandSpec, type CommandRejection } from './command';
import { type BrokerConversationGrant, Gateway } from './gateway';

import type { Message, MessageContent } from '../agent/context/message';
import type { ModelConfig, TextGenerateOptions } from '../provider/config';
import type { ProviderSourceEvent } from '../provider/stream';
import type { GatePolicyInput } from '../tool/gate';
import type {
  Broker,
  BrokerCapabilities,
  BrokerHistory,
  BrokerHost,
  BrokerSession,
  OutboundEvent,
  OutboundRunCompleted,
} from './broker';

const MODEL: ModelConfig = {
  inputModalities: ['text'],
  modelId: 'test-model',
  outputModalities: ['text'],
};

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

/** Thinks out loud, calls a tool, then answers — one run with something of every kind in it. */
class VerboseProvider extends ChatProvider {
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
      yield { text: 'pienso ', type: 'reasoningFragment' };
      yield { text: 'un poco', type: 'reasoningFragment' };
      yield {
        toolCall: {
          arguments: { value: 'x' },
          name: 'echo',
          role: 'toolCall',
          trackId: 'echo-1',
        },
        type: 'toolCall',
      };
    } else {
      yield { text: 'done', type: 'textFragment' };
    }
    yield { type: 'end', usage: { inputTokens: 3, outputTokens: 5 } };
  }
}

/** One settled provider reply, useful for proving per-conversation agent routing. */
class SayingProvider extends ChatProvider {
  readonly #text: string;

  constructor(text: string) {
    super({ baseUrl: 'https://provider.invalid', maxRetries: 0 });
    this.#text = text;
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
    yield { text: this.#text, type: 'textFragment' };
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

/**
 * Answers, then keeps going until something stops it. A steer and a stop are
 * both about a run that is still in flight, and a provider that finishes before
 * the test can speak proves nothing.
 */
class SlowProvider extends ChatProvider {
  constructor() {
    super({ baseUrl: 'https://provider.invalid', maxRetries: 0 });
  }

  public override fetchModelIds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  protected override async *attempt(
    _systemPrompt: string,
    _messageHistory: Message[],
    _tools: Tool[],
    _opts: TextGenerateOptions | undefined,
    signal: AbortSignal,
  ): AsyncIterable<ProviderSourceEvent> {
    yield { text: 'sigo ', type: 'textFragment' };
    await interrupted(signal);
    yield { text: 'hablando', type: 'textFragment' };
    yield { type: 'end' };
  }
}

/** Resolves the moment a run is cut short, and eventually if nothing cuts it. */
function interrupted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1_000);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
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

  public sayContent(
    conversationId: string,
    content: readonly MessageContent[],
    senderId = 'someone',
  ): void {
    this.#messages += 1;
    this.#host?.receive({
      content,
      conversationId,
      messageId: `m${String(this.#messages)}`,
      senderId,
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

  /** Says something over the top of the run in flight. */
  public interrupt(conversationId: string, text: string, senderId = 'someone'): void {
    this.#messages += 1;
    this.#host?.receive({
      conversationId,
      messageId: `s${String(this.#messages)}`,
      senderId,
      text,
      type: 'steer',
    });
  }

  /** Invokes a command, and reports back whether it was even accepted. */
  public invoke(
    conversationId: string,
    command: string,
    args?: Readonly<Record<string, unknown>>,
    senderId = 'someone',
  ): CommandRejection | undefined {
    return this.#requireHost().command({ arguments: args, command, conversationId, senderId });
  }

  /** Stops the run in flight, which is what a bare stop means. */
  public halt(conversationId: string, scope?: 'run' | 'session'): CommandRejection | undefined {
    return this.invoke(conversationId, 'stop', scope === undefined ? undefined : { scope });
  }

  public commands(): readonly BrokerCommandSpec[] {
    return this.#requireHost().commands;
  }

  public history(conversationId: string, limit?: number): Promise<BrokerHistory | undefined> {
    return this.#requireHost().history(conversationId, limit === undefined ? undefined : { limit });
  }

  public sessions(): Promise<readonly BrokerSession[]> {
    return this.#requireHost().sessions();
  }

  public texts(type: OutboundEvent['type']): string[] {
    return this.delivered
      .filter((event) => event.type === type)
      .map((event) => ('text' in event ? event.text : ''));
  }

  #requireHost(): BrokerHost {
    if (this.#host === undefined) throw new Error('The broker was never started.');
    return this.#host;
  }
}

function echoTool(): Tool {
  return {
    authority: TEST_AUTHORITY,
    description: 'echoes',
    name: 'echo',
    parameters: z.object({}),
    prepare: () => ({
      run: (): Promise<MessageContent[]> => Promise.resolve([{ text: 'echoed', type: 'text' }]),
      title: 'Echo a value',
      type: 'immediate' as const,
    }),
  };
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
    conversations?: Readonly<Record<string, BrokerConversationGrant>>;
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
        conversations: options.conversations,
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

/** The runs a transport was told about the end of, in the order they ended. */
function finished(broker: TestBroker): OutboundRunCompleted[] {
  return broker.delivered.filter((event) => event.type === 'runCompleted');
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

  test('preserves structured media from broker ingress through transcript and history', async () => {
    const broker = new TestBroker();
    const harnessed = await harness(await openDatabase(), broker);
    const content: MessageContent[] = [
      { text: 'What is shown here?', type: 'text' },
      { source: { type: 'url', url: 'https://images.test/object.png' }, type: 'image' },
    ];

    broker.sayContent('chat-1', content, 'alice');
    await settle(harnessed);

    const user = harnessed.application.sessions[0]?.session
      .getTranscript()
      .find((message) => message.role === 'user');
    expect(user?.role === 'user' ? user.content : undefined).toEqual(content);

    const history = await broker.history('chat-1');
    const entry = history?.entries.find((candidate) => candidate.type === 'userMessage');
    expect(entry?.type === 'userMessage' ? entry.content : undefined).toEqual(content);
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

  test('routes a configured conversation to its replacement agent', async () => {
    const database = await openDatabase();
    const broker = new TestBroker();
    const application = new NoxApplication();
    applications.push(application);
    await application.start();
    for (const [agentId, text] of [
      ['reader', 'reader reply'],
      ['admin', 'admin reply'],
    ] as const) {
      application.addAgent(
        new Agent(database, new SayingProvider(text), MODEL, {
          agentId,
          authorities: catalog,
          systemPrompt: 'system',
        }),
      );
    }
    const gateway = new Gateway(application, {
      brokers: [
        {
          agentId: 'reader',
          broker,
          brokerId: 'test',
          conversations: { admin: { agentId: 'admin' } },
        },
      ],
      database,
    });
    application.setGateway(gateway);
    await gateway.start();
    const harnessed = { application, broker, gateway };

    broker.say('public', 'hola', undefined, 'alice');
    await settle(harnessed);
    broker.say('admin', 'hola', undefined, 'alice');
    await settle(harnessed);

    expect(broker.texts('message')).toEqual(['reader reply', 'admin reply']);
    expect(application.sessions.map(({ agentId }) => agentId).sort()).toEqual(['admin', 'reader']);
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
      conversations?: Readonly<Record<string, BrokerConversationGrant>>,
    ): Promise<{ executions: { count: number }; harnessed: Harness }> {
      const executions = { count: 0 };
      const harnessed = await harness(await openDatabase(), broker, {
        conversations,
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

    test('replaces grants for a configured conversation', async () => {
      const broker = new TestBroker({ permissions: true });
      const adminAuthorization = new GrantAuthorizationProvider('test', { alice: ['*'] }, catalog);
      const { executions, harnessed } = await guarded(
        broker,
        {},
        {
          admin: {
            agentId: 'assistant',
            authorization: adminAuthorization,
          },
        },
      );

      broker.say('public', 'usa echo', undefined, 'alice');
      await settle(harnessed);
      expect(broker.delivered.filter((event) => event.type === 'permission')).toEqual([]);

      broker.say('admin', 'usa echo', undefined, 'alice');
      const asked = await waitFor(
        () =>
          broker.delivered.find(
            (event): event is Extract<OutboundEvent, { type: 'permission' }> =>
              event.type === 'permission' && event.conversationId === 'admin',
          ),
        'An admin permission request',
      );
      broker.answer('admin', asked.request.requestId, 'alice', { approved: 'once' });
      await settle(harnessed);

      expect(executions.count).toBe(1);
      expect(harnessed.application.sessions).toHaveLength(2);
    });

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

    test('keeps a detached resolution correlated to its originating turn', async () => {
      const broker = new TestBroker({ permissions: true, streaming: false });
      const { harnessed } = await guarded(broker, { alice: ['*'] });

      broker.say('chat-1', 'usa echo', undefined, 'alice');
      const asked = await waitFor(
        () => broker.delivered.find((event) => event.type === 'permission'),
        'A permission request',
      );

      // Bob is the second principal: his arrival promotes Alice's existing wait
      // to detached, and his own turn advances the conversation turn ID.
      broker.say('chat-1', 'hola', undefined, 'bob');
      await settle(harnessed);
      expect(
        broker.delivered.some((event) => event.type === 'message' && event.turnId !== asked.turnId),
      ).toBeTrue();

      broker.answer('chat-1', asked.request.requestId, 'alice', { approved: 'once' });
      await harnessed.gateway.drain();
      const resolved = await waitFor(
        () => broker.delivered.find((event) => event.type === 'permissionResolved'),
        'A permission resolution',
      );

      expect(resolved.turnId).toBe(asked.turnId);
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
  /**
   * What a run produces and what a surface shows are different questions. These
   * are about the second one belonging to the transport: the same run, watched
   * by two brokers, is two different amounts of detail.
   */
  describe('what a transport declares', () => {
    async function verbose(broker: TestBroker): Promise<Harness> {
      return harness(await openDatabase(), broker, {
        gate: { defaultVerdict: 'allow' },
        provider: new VerboseProvider(),
        toolSets: [{ toolSet: new TestToolSet([echoTool()]), toolSetId: 'direct' }],
      });
    }

    /** Every kind of event this run produced, in the order it was delivered. */
    function types(broker: TestBroker): string[] {
      return [...new Set(broker.delivered.map((event) => event.type))];
    }

    test('sends a transport that declared nothing the settled reply and nothing else', async () => {
      const broker = new TestBroker();
      const harnessed = await verbose(broker);

      broker.say('chat-1', 'usa echo');
      await settle(harnessed);

      // A bot in a channel can post text. The run reasoned, called a tool, spent
      // tokens and finished, and none of that is something it could draw.
      expect(types(broker)).toEqual(['message']);
      expect(broker.texts('message')).toEqual(['done']);
    });

    test('sends a transport everything it declared', async () => {
      const broker = new TestBroker({
        contextChanges: true,
        contextUsage: true,
        reasoning: true,
        retries: true,
        runs: true,
        streaming: true,
        toolActivity: true,
        usage: true,
      });
      const harnessed = await verbose(broker);

      broker.say('chat-1', 'usa echo');
      await settle(harnessed);
      // The last event of a run reaches the watcher after the runner is idle.
      const completed = await waitFor(
        () => broker.delivered.find((event) => event.type === 'runCompleted'),
        'A completed run',
      );

      expect(types(broker)).toContainAllValues([
        // Declared `contextChanges`, and a settled tool loop folds, so this
        // transport genuinely receives one.
        'contextChange',
        'contextUsage',
        'fragment',
        'message',
        'reasoning',
        'reasoningFragment',
        'runCompleted',
        'runStarted',
        'toolCall',
        'toolResponse',
        'usage',
      ]);

      const context = broker.delivered.findLast((event) => event.type === 'contextUsage');
      if (context?.type !== 'contextUsage') throw new Error('Expected context accounting.');
      expect(context.usage.usedTokens).toBeGreaterThan(0);

      const call = broker.delivered.find((event) => event.type === 'toolCall');
      expect(call).toMatchObject({ arguments: { value: 'x' }, name: 'echo', trackId: 'echo-1' });

      const response = broker.delivered.find((event) => event.type === 'toolResponse');
      expect(response).toMatchObject({
        execution: 'immediate',
        isError: false,
        name: 'echo',
        text: 'echoed',
        trackId: 'echo-1',
      });

      expect(completed).toMatchObject({ status: 'completed' });
      expect(completed.usage?.outputTokens).toBe(10);

      // The reply and everything around it belong to the same run, so a surface
      // can group them without guessing.
      expect(new Set(broker.delivered.map((event) => event.turnId)).size).toBe(1);
    });

    test('keeps token accounting out of a run a transport only wanted the shape of', async () => {
      const broker = new TestBroker({ runs: true });
      const harnessed = await verbose(broker);

      broker.say('chat-1', 'usa echo');
      await settle(harnessed);

      const completed = await waitFor(
        () => broker.delivered.find((event) => event.type === 'runCompleted'),
        'A completed run',
      );

      expect(completed).toMatchObject({ status: 'completed' });
      // Declared `runs`, not `usage`: the totals ride along with a run, but they
      // are token accounting either way.
      expect(completed.usage).toBeUndefined();
      expect(types(broker)).not.toContain('usage');
    });

    test('settles reasoning for a transport that cannot show a thing being written', async () => {
      const broker = new TestBroker({ reasoning: true });
      const harnessed = await verbose(broker);

      broker.say('chat-1', 'usa echo');
      await settle(harnessed);

      // What the model thought, once it is a whole thought. A fragment is only
      // useful to a surface that can rewrite what it already showed.
      expect(broker.texts('reasoning')).toEqual(['pienso un poco']);
      expect(types(broker)).not.toContain('reasoningFragment');
    });
  });

  describe('steering and stopping', () => {
    test('cuts the run short and answers what was said over it', async () => {
      const broker = new TestBroker({ runs: true });
      const harnessed = await harness(await openDatabase(), broker, {
        provider: new SlowProvider(),
      });

      broker.say('chat-1', 'contame algo largo');
      await waitFor(
        () => broker.delivered.find((event) => event.type === 'runStarted'),
        'A started run',
      );
      broker.interrupt('chat-1', 'mejor no');
      await settle(harnessed);
      await waitFor(() => (finished(broker).length === 2 ? true : undefined), 'Two finished runs');

      const runs = broker.delivered.filter((event) => event.type === 'runStarted');

      // The first run never finished saying what it was saying, and the second
      // is not a reply to it: it is what was said over the top of it.
      expect(finished(broker).map((run) => run.status)).toEqual(['aborted', 'completed']);
      expect(runs.map((run) => run.trigger)).toEqual(['user', 'steer']);
    });

    test('steers an idle conversation, which is only talking', async () => {
      const broker = new TestBroker({ runs: true });
      const harnessed = await harness(await openDatabase(), broker);

      broker.interrupt('chat-1', 'hola');
      await settle(harnessed);
      await waitFor(() => (finished(broker).length === 1 ? true : undefined), 'A finished run');

      expect(broker.texts('message')).toEqual(['hola mundo']);
      expect(finished(broker).map((run) => run.status)).toEqual(['completed']);
    });

    test('stops the run in flight and leaves the conversation open', async () => {
      const broker = new TestBroker({ runs: true });
      const harnessed = await harness(await openDatabase(), broker, {
        provider: new SlowProvider(),
      });

      broker.say('chat-1', 'contame algo largo');
      await waitFor(
        () => broker.delivered.find((event) => event.type === 'runStarted'),
        'A started run',
      );
      broker.halt('chat-1');
      await settle(harnessed);
      await waitFor(() => (finished(broker).length === 1 ? true : undefined), 'A finished run');

      expect(finished(broker).map((run) => run.status)).toEqual(['aborted']);
      // Told that is enough, not shown the door: the session is still the one
      // this chat is, and the next message is another turn of it.
      expect(harnessed.application.sessions).toHaveLength(1);
      expect(harnessed.application.sessions[0]?.session.state).toBe('idle');
    });

    test('ends the session on request and reopens the same transcript after it', async () => {
      const broker = new TestBroker();
      const harnessed = await harness(await openDatabase(), broker);

      broker.say('chat-1', 'primera');
      await settle(harnessed);
      const sessionId = harnessed.application.sessions[0]?.session.sessionId;

      broker.halt('chat-1', 'session');
      await harnessed.gateway.drain();
      expect(harnessed.application.sessions).toHaveLength(0);

      // The binding outlives the session, so this is the same conversation
      // continuing rather than a new one starting.
      broker.say('chat-1', 'segunda');
      await settle(harnessed);
      const reopened = harnessed.application.sessions[0]?.session;
      expect(reopened?.sessionId).toBe(sessionId);
      expect(reopened?.getTranscript().filter((message) => message.role === 'user')).toHaveLength(
        2,
      );
    });
  });

  describe('reading a conversation back', () => {
    test('answers with both sides of it, attributed', async () => {
      const broker = new TestBroker();
      const harnessed = await harness(await openDatabase(), broker);

      broker.say('chat-1', 'hola', undefined, 'someone');
      await settle(harnessed);

      const history = await broker.history('chat-1');
      expect(history?.agentId).toBe('assistant');
      expect(history?.entries.map((entry) => entry.type)).toEqual(['userMessage', 'message']);

      const [said, replied] = history?.entries ?? [];
      // The live stream withholds what a participant said; a transcript cannot,
      // and it says who said it.
      expect(said).toMatchObject({
        principal: { issuer: 'test', subject: 'someone' },
        text: 'hola',
        type: 'userMessage',
      });
      expect(replied).toMatchObject({ text: 'hola mundo', type: 'message' });
    });

    test('filters a transcript by the capabilities the stream is filtered by', async () => {
      const broker = new TestBroker();
      const harnessed = await harness(await openDatabase(), broker, {
        gate: { defaultVerdict: 'allow' },
        provider: new VerboseProvider(),
        toolSets: [{ toolSet: new TestToolSet([echoTool()]), toolSetId: 'direct' }],
      });

      broker.say('chat-1', 'usa echo');
      await settle(harnessed);

      // Scrolling up shows what watching would have shown and nothing more: a
      // transport that never asked for tool activity does not start seeing it.
      const history = await broker.history('chat-1');
      expect(history?.entries.map((entry) => entry.type)).toEqual(['userMessage', 'message']);
    });

    test('shows a verbose transport everything it declared', async () => {
      const broker = new TestBroker({ reasoning: true, toolActivity: true });
      const harnessed = await harness(await openDatabase(), broker, {
        gate: { defaultVerdict: 'allow' },
        provider: new VerboseProvider(),
        toolSets: [{ toolSet: new TestToolSet([echoTool()]), toolSetId: 'direct' }],
      });

      broker.say('chat-1', 'usa echo');
      await settle(harnessed);

      const history = await broker.history('chat-1');
      expect(history?.entries.map((entry) => entry.type)).toEqual([
        'userMessage',
        'reasoning',
        'toolCall',
        'toolResponse',
        'message',
      ]);

      // The last of a conversation, which is what a surface redrawing a chat
      // that has been going for a week actually asks for.
      const tail = await broker.history('chat-1', 2);
      expect(tail?.entries.map((entry) => entry.type)).toEqual(['toolResponse', 'message']);
    });

    test('reads a conversation nobody has reopened, without opening it', async () => {
      const database = await openDatabase();
      const before = new TestBroker();
      const first = await harness(database, before);

      before.say('chat-1', 'hola');
      await settle(first);
      await first.application.stop();

      const after = new TestBroker();
      const second = await harness(database, after);

      const history = await after.history('chat-1');
      expect(history?.entries.map((entry) => entry.type)).toEqual(['userMessage', 'message']);
      // Asking what was said is not speaking: nothing was reopened to answer it.
      expect(second.application.sessions).toHaveLength(0);
    });

    test('has nothing to say about a chat that was never bound', async () => {
      const broker = new TestBroker();
      await harness(await openDatabase(), broker);

      expect(await broker.history('never-spoken-in')).toBeUndefined();
    });
  });

  describe('listing what a transport is carrying', () => {
    test('lists every bound conversation, most recently spoken in first', async () => {
      const broker = new TestBroker();
      const harnessed = await harness(await openDatabase(), broker);

      broker.say('chat-1', 'primera');
      await settle(harnessed);
      await Bun.sleep(2);
      broker.say('chat-2', 'segunda');
      await settle(harnessed);

      const sessions = await broker.sessions();
      expect(sessions.map((session) => session.conversationId)).toEqual(['chat-2', 'chat-1']);
      expect(sessions.every((session) => session.state === 'idle')).toBeTrue();
      expect(sessions[0]?.agentId).toBe('assistant');
    });

    test('calls a bound conversation nobody has reopened closed', async () => {
      const database = await openDatabase();
      const before = new TestBroker();
      const first = await harness(database, before);

      before.say('chat-1', 'hola');
      await settle(first);
      await first.application.stop();

      const after = new TestBroker();
      await harness(database, after);

      // Bound but not open is the ordinary state of a chat after a restart, and
      // one missing from the list would look deleted.
      const [session] = await after.sessions();
      expect(session).toMatchObject({ conversationId: 'chat-1', state: 'closed' });
    });

    test('shows a conversation as running while its run is in flight', async () => {
      const broker = new TestBroker({ runs: true });
      const harnessed = await harness(await openDatabase(), broker, {
        provider: new SlowProvider(),
      });

      broker.say('chat-1', 'contame algo largo');
      await waitFor(
        () => broker.delivered.find((event) => event.type === 'runStarted'),
        'A started run',
      );

      const [session] = await broker.sessions();
      expect(session?.state).toBe('running');

      broker.halt('chat-1');
      await settle(harnessed);
    });

    test('does not enumerate what another transport is carrying', async () => {
      const database = await openDatabase();
      const mine = new TestBroker();
      const theirs = new TestBroker();

      const application = new NoxApplication();
      applications.push(application);
      await application.start();
      application.addAgent(
        new Agent(database, new SayingProvider('ok'), MODEL, {
          agentId: 'assistant',
          authorities: catalog,
          systemPrompt: 'system',
        }),
      );
      const gateway = new Gateway(application, {
        brokers: [
          { agentId: 'assistant', broker: mine, brokerId: 'mine' },
          { agentId: 'assistant', broker: theirs, brokerId: 'theirs' },
        ],
        database,
      });
      application.setGateway(gateway);
      await gateway.start();
      const harnessed = { application, broker: mine, gateway };

      mine.say('chat-1', 'hola');
      theirs.say('chat-2', 'hola');
      await settle(harnessed);

      expect((await mine.sessions()).map((session) => session.conversationId)).toEqual(['chat-1']);
      expect((await theirs.sessions()).map((session) => session.conversationId)).toEqual([
        'chat-2',
      ]);
      // A conversation on another transport is not this one's to read either.
      expect(await mine.history('chat-2')).toBeUndefined();
    });
  });

  describe('commands', () => {
    test('publishes a catalog a transport can render from', async () => {
      const broker = new TestBroker();
      await harness(await openDatabase(), broker);

      const [stop, ...rest] = broker.commands();
      expect(rest).toBeEmpty();
      expect(stop?.name).toBe('stop');
      // JSON Schema, because a zod schema does not cross a boundary — and this
      // is the same declaration an invocation is checked against.
      expect(stop?.parameters).toMatchObject({
        properties: { scope: { enum: ['run', 'session'] } },
        type: 'object',
      });
    });

    test('refuses a command nobody declared', async () => {
      const broker = new TestBroker();
      const harnessed = await harness(await openDatabase(), broker);

      broker.say('chat-1', 'hola');
      await settle(harnessed);

      expect(broker.invoke('chat-1', 'selfDestruct')).toEqual({ reason: 'unknownCommand' });
    });

    test('refuses arguments that do not fit, and says why', async () => {
      const broker = new TestBroker();
      const harnessed = await harness(await openDatabase(), broker);

      broker.say('chat-1', 'hola');
      await settle(harnessed);

      const rejection = broker.invoke('chat-1', 'stop', { scope: 'everything' });

      // The two things a client can act on come back straight away, checked
      // against the very schema it rendered from.
      expect(rejection?.reason).toBe('invalidArguments');
      expect(rejection).toHaveProperty('detail');
      expect(harnessed.application.sessions[0]?.session.state).toBe('idle');
    });

    test('applies a command schema default rather than guessing at the surface', async () => {
      const broker = new TestBroker({ runs: true });
      const harnessed = await harness(await openDatabase(), broker, {
        provider: new SlowProvider(),
      });

      broker.say('chat-1', 'contame algo largo');
      await waitFor(
        () => broker.delivered.find((event) => event.type === 'runStarted'),
        'A started run',
      );

      // No scope named at all: the schema says `run`, so the conversation
      // survives a bare stop rather than being ended by an omission.
      expect(broker.invoke('chat-1', 'stop')).toBeUndefined();
      await settle(harnessed);

      expect(finished(broker).map((run) => run.status)).toEqual(['aborted']);
      expect(harnessed.application.sessions).toHaveLength(1);
    });

    test('runs a contributed command with everything it needs and nothing more', async () => {
      const database = await openDatabase();
      const broker = new TestBroker();
      const seen: { conversationId: string; sender: string; tags: string[] }[] = [];

      const application = new NoxApplication();
      applications.push(application);
      await application.start();
      application.addAgent(
        new Agent(database, new SayingProvider('ok'), MODEL, {
          agentId: 'assistant',
          authorities: catalog,
          systemPrompt: 'system',
        }),
      );
      const gateway = new Gateway(application, {
        brokers: [{ agentId: 'assistant', broker, brokerId: 'test' }],
        // A list parameter costs nothing extra: the schema is the whole
        // declaration, and every surface derives what it draws from it.
        commands: [
          brokerCommand({
            description: 'Tags a conversation.',
            name: 'tag',
            parameters: z.object({ tags: z.array(z.enum(['urgent', 'later', 'done'])).min(1) }),
            run: (context, { tags }): Promise<void> => {
              seen.push({
                conversationId: context.conversationId,
                sender: context.sender.subject,
                tags: [...tags],
              });
              return Promise.resolve();
            },
          }),
        ],
        database,
      });
      application.setGateway(gateway);
      await gateway.start();
      const harnessed = { application, broker, gateway };

      broker.say('chat-1', 'hola');
      await settle(harnessed);

      expect(broker.commands().map((command) => command.name)).toEqual(['stop', 'tag']);
      expect(broker.invoke('chat-1', 'tag', { tags: ['urgent', 'done'] }, 'alice')).toBeUndefined();
      await harnessed.gateway.drain();

      expect(seen).toEqual([
        { conversationId: 'chat-1', sender: 'alice', tags: ['urgent', 'done'] },
      ]);
      // A multiple choice is checked like anything else.
      expect(broker.invoke('chat-1', 'tag', { tags: [] })?.reason).toBe('invalidArguments');
      expect(broker.invoke('chat-1', 'tag', { tags: ['nope'] })?.reason).toBe('invalidArguments');
    });

    test('refuses to register two commands under one name', async () => {
      const database = await openDatabase();
      const application = new NoxApplication();
      applications.push(application);
      await application.start();

      const shadow = brokerCommand({
        description: 'Not the stop anyone rendered.',
        name: 'stop',
        parameters: z.object({}),
        run: (): Promise<void> => Promise.resolve(),
      });

      // A transport drew `stop` from the catalog. A deployment quietly
      // redefining what it does is what a declared vocabulary exists to prevent.
      expect(() => new Gateway(application, { brokers: [], commands: [shadow], database })).toThrow(
        'Command "stop" is registered more than once.',
      );
    });

    test('waits its turn behind whatever the conversation is already doing', async () => {
      const broker = new TestBroker({ runs: true });
      const harnessed = await harness(await openDatabase(), broker, {
        provider: new SlowProvider(),
      });

      broker.say('chat-1', 'contame algo largo');
      await waitFor(
        () => broker.delivered.find((event) => event.type === 'runStarted'),
        'A started run',
      );
      broker.halt('chat-1', 'session');
      broker.say('chat-1', 'segunda');
      await settle(harnessed);

      // The message queued behind the command, so it reopened the conversation
      // the command had just ended rather than racing it.
      expect(harnessed.application.sessions).toHaveLength(1);
      expect(
        harnessed.application.sessions[0]?.session
          .getTranscript()
          .filter((message) => message.role === 'user'),
      ).toHaveLength(2);
    });

    test('has nothing to run in a conversation that is not open', async () => {
      const broker = new TestBroker();
      const harnessed = await harness(await openDatabase(), broker);

      // Accepted — the catalog is what a synchronous answer can speak to — and
      // then quietly dropped, because there is nothing to stop.
      expect(broker.halt('never-spoken-in')).toBeUndefined();
      await harnessed.gateway.drain();

      expect(harnessed.application.sessions).toHaveLength(0);
    });

    test('refuses everything once the gateway is no longer running', async () => {
      const broker = new TestBroker();
      const harnessed = await harness(await openDatabase(), broker);

      broker.say('chat-1', 'hola');
      await settle(harnessed);
      await harnessed.gateway.stop();

      expect(broker.halt('chat-1')).toEqual({ reason: 'unavailable' });
    });
  });
});
