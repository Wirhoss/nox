import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ChatProvider,
  commands,
  defineCommand,
  defineExtension,
  ToolSet,
} from '@nox/extension-api';
import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { Agent } from '../agent/agent';
import { NoxApplication } from '../application';
import { GrantAuthorizationProvider } from '../auth/authorization';
import { SYSTEM_CRON } from '../auth/principal';
import { Database } from '../database/database';
import { SessionStore } from '../database/sessionStore';
import { bindExtensionManifest } from '../extensions/extension';
import { TEST_AUTHORITY, testCatalog } from '../testFixtures';
import { brokerCommand, CommandCatalog } from './command';
import { Gateway } from './gateway';

import type { GatePolicyInput } from '../tool/gate';
import type { BrokerConversationGrant } from './gateway';
import type {
  Broker,
  BrokerCapabilities,
  BrokerCommandSpec,
  BrokerHistory,
  BrokerHost,
  BrokerSession,
  ChatModelConfig,
  CommandRejection,
  Message,
  MessageContent,
  OutboundEvent,
  OutboundRunCompleted,
  ProviderSourceEvent,
  TextGenerateOptions,
  Tool,
  ToolDeclaration,
  ToolSetGrant,
} from '@nox/extension-api';

const MODEL: ChatModelConfig = {
  kind: 'chat',
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
    super({ maxRetries: 0 });
  }

  public override fetchModelIds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  protected override async *attempt(
    _systemPrompt: string,
    _messageHistory: Message[],
    _tools: readonly ToolDeclaration[],
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
    super({ maxRetries: 0 });
  }

  public override fetchModelIds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  protected override async *attempt(
    _systemPrompt: string,
    messageHistory: Message[],
    _tools: readonly ToolDeclaration[],
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
    super({ maxRetries: 0 });
    this.#text = text;
  }

  public override fetchModelIds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  protected override async *attempt(
    _systemPrompt: string,
    _messageHistory: Message[],
    _tools: readonly ToolDeclaration[],
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
    super({ maxRetries: 0 });
  }

  public override fetchModelIds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  protected override async *attempt(
    _systemPrompt: string,
    messageHistory: Message[],
    _tools: readonly ToolDeclaration[],
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
 * Answers, then keeps going until something stops it. Stop tests need a run
 * that is still in flight; a provider that finishes before the test can act
 * proves nothing.
 */
class SlowProvider extends ChatProvider {
  constructor() {
    super({ maxRetries: 0 });
  }

  public override fetchModelIds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  protected override async *attempt(
    _systemPrompt: string,
    _messageHistory: Message[],
    _tools: readonly ToolDeclaration[],
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

/** Pauses its first reply so steering can arrive while work is demonstrably active. */
class PausingProvider extends ChatProvider {
  public readonly firstPaused: Promise<void>;
  public firstAborted = false;

  #markFirstPaused!: () => void;
  #releaseFirst?: () => void;

  constructor() {
    super({ maxRetries: 0 });
    this.firstPaused = new Promise<void>((resolve) => {
      this.#markFirstPaused = resolve;
    });
  }

  public override fetchModelIds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  public releaseFirst(): void {
    this.#releaseFirst?.();
  }

  protected override async *attempt(
    _systemPrompt: string,
    messageHistory: Message[],
    _tools: readonly ToolDeclaration[],
    _opts: TextGenerateOptions | undefined,
    signal: AbortSignal,
  ): AsyncIterable<ProviderSourceEvent> {
    const userMessages = messageHistory.filter((message) => message.role === 'user').length;
    if (userMessages === 1) {
      yield { text: 'termino esto', type: 'textFragment' };
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          this.#releaseFirst = undefined;
          resolve();
        };
        const onAbort = (): void => {
          this.firstAborted = true;
          finish();
        };
        this.#releaseFirst = () => {
          signal.removeEventListener('abort', onAbort);
          finish();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        this.#markFirstPaused();
      });
    } else {
      yield { text: 'ahora lo nuevo', type: 'textFragment' };
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
  public starts = 0;
  public stopped = false;

  /** Channels this transport refuses, the way Discord refuses an unknown one. */
  public readonly unreachable = new Set<string>();

  #host?: BrokerHost;
  #messages = 0;

  constructor(capabilities: BrokerCapabilities = {}) {
    this.capabilities = capabilities;
  }

  public canDeliverTo(channelId: string): Promise<boolean> {
    return Promise.resolve(!this.unreachable.has(channelId));
  }

  public deliver(event: OutboundEvent): Promise<void> {
    if (this.unreachable.has(event.conversationId)) {
      return Promise.reject(new Error(`Refused a message addressed to "${event.conversationId}".`));
    }
    this.delivered.push(event);
    return Promise.resolve();
  }

  public start(host: BrokerHost): Promise<void> {
    this.#host = host;
    this.starts += 1;
    this.stopped = false;
    return Promise.resolve();
  }

  public stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }

  /** Someone says something. The id is the transport's own, reused to retry. */
  public say(conversationId: string, text: string, messageId?: string, senderId = 'someone'): void {
    this.#messages += 1;
    void this.#host?.receive({
      content: [{ text, type: 'text' }],
      conversationId,
      messageId: messageId ?? `m${String(this.#messages)}`,
      senderId,
      type: 'message',
    });
  }

  public sayContent(
    conversationId: string,
    content: readonly MessageContent[],
    senderId = 'someone',
  ): void {
    this.#messages += 1;
    void this.#host?.receive({
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
    void this.#host?.receive({
      conversationId,
      requestId,
      resolution,
      senderId,
      type: 'permission',
    });
  }

  /** Adds direction at the next opening in the run in flight. */
  public steer(conversationId: string, text: string, senderId = 'someone'): void {
    this.#messages += 1;
    void this.#host?.receive({
      content: [{ text, type: 'text' }],
      conversationId,
      messageId: `s${String(this.#messages)}`,
      senderId,
      type: 'steer',
    });
  }

  /** Invokes a command, and reports back whether it was even accepted. */
  public invoke(
    conversationId: string,
    command: string,
    args?: Readonly<Record<string, unknown>>,
    senderId = 'someone',
  ): Promise<CommandRejection | undefined> {
    return this.#requireHost().command({ arguments: args, command, conversationId, senderId });
  }

  /** Stops the run in flight, which is what a bare stop means. */
  public halt(
    conversationId: string,
    scope?: 'run' | 'session',
  ): Promise<CommandRejection | undefined> {
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

/**
 * A transport whose channels are conversations rather than places, the way the
 * web surface's are: there is no room to post an unattended reply into, so it
 * asks for one of its own.
 */
class ConversationBroker extends TestBroker {
  public readonly opened: string[] = [];

  public openScheduledConversation(): string {
    const conversationId = `own_${String(this.opened.length + 1)}`;
    this.opened.push(conversationId);
    return conversationId;
  }
}

class FailingBroker extends TestBroker {
  public override start(_host: BrokerHost): Promise<void> {
    return Promise.reject(new Error('candidate cannot connect'));
  }
}

class StopFailingBroker extends TestBroker {
  #fails = true;

  public override stop(): Promise<void> {
    if (!this.#fails) return super.stop();
    this.#fails = false;
    return Promise.reject(new Error('transport cannot stop'));
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

  test('runs cron in a fresh agent session and delivers only the result to a channel', async () => {
    const broker = new TestBroker({ runs: true });
    const database = await openDatabase();
    const harnessed = await harness(database, broker);
    harnessed.application.addAgent(
      new Agent(database, new SayingProvider('selected agent result'), MODEL, {
        agentId: 'cron-specialist',
        authorities: catalog,
        systemPrompt: 'specialized cron prompt',
      }),
    );
    broker.say('chat-1', 'initial');
    await settle(harnessed);
    const conversation = harnessed.application.sessions[0]?.session;
    expect(conversation).toBeDefined();

    const result = await harnessed.gateway.runScheduledAgent({
      agentId: 'cron-specialist',
      causeId: 'cron-run-1',
      delivery: { brokerId: 'test', channelId: 'alerts-channel' },
      name: 'Morning automation',
      prompt: 'scheduled prompt',
      sessionId: 'fresh-cron-session',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      content: [{ text: 'selected agent result', type: 'text' }],
      sessionId: 'fresh-cron-session',
      status: 'completed',
    });
    expect(result.deliveredAt).toBeInstanceOf(Date);
    expect(harnessed.application.sessions).toHaveLength(1);
    expect(conversation?.getTranscript().filter((message) => message.role === 'user')).toHaveLength(
      1,
    );
    const stored = await new SessionStore(database).load('fresh-cron-session');
    expect(stored?.session.agentId).toBe('cron-specialist');
    expect(stored?.messages.find((message) => message.role === 'user')).toMatchObject({
      content: [{ text: 'scheduled prompt', type: 'text' }],
      origin: { principal: SYSTEM_CRON, transportMessageId: 'cron-run-1' },
    });
    expect(
      broker.delivered.filter(
        (event) => event.type === 'message' && event.conversationId === 'alerts-channel',
      ),
    ).toMatchObject([{ content: [{ text: 'selected agent result', type: 'text' }] }]);
    const starts = broker.delivered.filter((event) => event.type === 'runStarted');
    expect(starts.map((event) => event.trigger)).toEqual(['user']);
  });

  test('gives an unattended reply its own conversation when the transport asks for one', async () => {
    // The original failure: "deliver it back here" on the web surface addressed
    // the conversation that scheduled the job. A channel there is a browser's
    // own conversation ID, so the answer was pushed at a transcript a person was
    // still using — and only as a live event, which nothing replayed. The run
    // recorded a delivery; nothing ever showed one.
    const broker = new ConversationBroker();
    const harnessed = await harness(await openDatabase(), broker);
    broker.say('chat-1', 'initial');
    await settle(harnessed);
    const spokenToChat = (): number =>
      broker.delivered.filter(
        (event) => event.type === 'message' && event.conversationId === 'chat-1',
      ).length;
    const beforeRun = spokenToChat();

    const result = await harnessed.gateway.runScheduledAgent({
      agentId: 'assistant',
      causeId: 'cron-run-own',
      delivery: { brokerId: 'test', channelId: 'chat-1' },
      name: 'Morning automation',
      prompt: 'scheduled prompt',
      sessionId: 'cron-session-own',
      signal: new AbortController().signal,
    });

    expect(result.deliveredAt).toBeInstanceOf(Date);
    expect(broker.opened).toEqual(['own_1']);
    // Beside the conversation that asked, never inside it.
    expect(
      broker.delivered.filter((event) => event.type === 'message').map((e) => e.conversationId),
    ).toContain('own_1');
    expect(spokenToChat()).toBe(beforeRun);

    // Bound, which is what makes it readable at all afterwards: the surface
    // lists it, and its transcript is the run's own session.
    const carried = await broker.sessions();
    expect(carried.find((session) => session.conversationId === 'own_1')).toMatchObject({
      agentId: 'assistant',
      sessionId: 'cron-session-own',
      title: 'Morning automation',
    });
    const history = await broker.history('own_1');
    expect(history?.sessionId).toBe('cron-session-own');
    expect(
      history?.entries.some(
        (entry) => entry.type === 'userMessage' && entry.text === 'scheduled prompt',
      ),
    ).toBe(true);
  });

  test('records a refused scheduled delivery as an error instead of a delivery', async () => {
    // The original failure: Discord answered 404 to the post, the broker logged
    // it and returned, and the run was stored as delivered at the very instant
    // the message bounced. Nothing a person could read said it had not arrived.
    const broker = new TestBroker();
    broker.unreachable.add('222120611298672640');
    const harnessed = await harness(await openDatabase(), broker);

    const result = await harnessed.gateway.runScheduledAgent({
      agentId: 'assistant',
      causeId: 'cron-run-404',
      delivery: { brokerId: 'test', channelId: '222120611298672640' },
      name: 'Greeting',
      prompt: 'say hello',
      sessionId: 'cron-session-404',
      signal: new AbortController().signal,
    });

    expect(result.deliveredAt).toBeUndefined();
    expect(result.deliveryError).toContain('222120611298672640');
    // The run itself completed — the agent did its work. Only the delivery
    // failed, and the two stay separately true.
    expect(result.status).toBe('completed');
  });

  test('answers whether a transport will take an address, and where a session already is', async () => {
    const broker = new TestBroker();
    broker.unreachable.add('222120611298672640');
    const harnessed = await harness(await openDatabase(), broker);
    const signal = new AbortController().signal;

    expect(
      await harnessed.gateway.canDeliverTo(
        { brokerId: 'test', channelId: '222120611298672640' },
        signal,
      ),
    ).toBe(false);
    expect(
      await harnessed.gateway.canDeliverTo({ brokerId: 'test', channelId: 'chat-1' }, signal),
    ).toBe(true);
    expect(
      await harnessed.gateway.canDeliverTo({ brokerId: 'absent', channelId: 'chat-1' }, signal),
    ).toBe(false);

    broker.say('chat-1', 'hola');
    await settle(harnessed);
    const sessionId = harnessed.application.sessions[0]?.session.sessionId;
    expect(sessionId).toBeDefined();

    expect(await harnessed.gateway.deliveryOrigin(sessionId ?? '', signal)).toEqual({
      brokerId: 'test',
      channelId: 'chat-1',
    });
    expect(await harnessed.gateway.deliveryOrigin('no-such-session', signal)).toBeUndefined();
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

  test('keeps an existing conversation on its bound agent when the route changes', async () => {
    const database = await openDatabase();
    const before = new TestBroker();
    const first = await harness(database, before);

    before.say('existing', 'primera');
    await settle(first);
    const sessionId = first.application.sessions[0]?.session.sessionId;
    await first.application.stop();

    const after = new TestBroker();
    const application = new NoxApplication();
    applications.push(application);
    await application.start();
    for (const [agentId, text] of [
      ['assistant', 'old agent reply'],
      ['replacement', 'new agent reply'],
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
      brokers: [{ agentId: 'replacement', broker: after, brokerId: 'test' }],
      database,
    });
    application.setGateway(gateway);
    await gateway.start();
    const second = { application, broker: after, gateway };

    after.say('existing', 'segunda');
    await settle(second);
    after.say('new', 'primera');
    await settle(second);

    expect(after.texts('message')).toEqual(['old agent reply', 'new agent reply']);
    const resumed = application.sessions.find(({ agentId }) => agentId === 'assistant');
    expect(resumed?.session.sessionId).toBe(sessionId);
    expect(
      resumed?.session.getTranscript().filter((message) => message.role === 'user'),
    ).toHaveLength(2);
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

  test('uses a conversation route without demanding a selectable broker default', async () => {
    const database = await openDatabase();
    const broker = new TestBroker();
    const application = new NoxApplication();
    applications.push(application);
    await application.start();
    application.addAgent(
      new Agent(database, new SayingProvider('admin reply'), MODEL, {
        agentId: 'admin',
        authorities: catalog,
        systemPrompt: 'system',
      }),
    );
    const gateway = new Gateway(application, {
      brokers: [
        {
          broker,
          brokerId: 'test',
          conversations: { admin: { agentId: 'admin' } },
          selectableAgent: true,
        },
      ],
      database,
    });
    application.setGateway(gateway);
    await gateway.start();

    broker.say('admin', 'hola');
    await settle({ application, broker, gateway });

    expect(broker.texts('message')).toEqual(['admin reply']);
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

  test('hot-replaces a broker and rejects the retired generation', async () => {
    const first = new TestBroker();
    const harnessed = await harness(await openDatabase(), first);
    const second = new TestBroker();

    first.say('chat-1', 'before');
    await settle(harnessed);
    await harnessed.gateway.replaceBroker({
      agentId: 'assistant',
      authorization: new GrantAuthorizationProvider('test', { someone: ['*'] }, catalog),
      broker: second,
      brokerId: 'test',
    });

    expect(first.stopped).toBeTrue();
    expect(harnessed.gateway.brokerIds).toEqual(['test']);
    first.say('chat-1', 'retired');
    second.say('chat-1', 'after');
    await settle(harnessed);

    expect(first.texts('message')).toEqual(['hola mundo']);
    expect(second.texts('message')).toEqual(['hola mundo']);
  });

  test('retains the prior route when broker removal cannot stop it', async () => {
    const broker = new StopFailingBroker();
    const harnessed = await harness(await openDatabase(), broker);

    expect(harnessed.gateway.removeBroker('test')).rejects.toThrow('cannot stop');
    expect(harnessed.gateway.brokerIds).toEqual(['test']);

    broker.say('chat-1', 'still here');
    await settle(harnessed);
    expect(broker.texts('message')).toEqual(['hola mundo']);
  });

  test('restores the prior broker when a replacement cannot start', async () => {
    const first = new TestBroker();
    const harnessed = await harness(await openDatabase(), first);

    expect(
      harnessed.gateway.replaceBroker({
        agentId: 'assistant',
        authorization: new GrantAuthorizationProvider('test', { someone: ['*'] }, catalog),
        broker: new FailingBroker(),
        brokerId: 'test',
      }),
    ).rejects.toThrow('cannot connect');

    expect(first.starts).toBe(2);
    expect(first.stopped).toBeFalse();
    first.say('chat-1', 'still here');
    await settle(harnessed);
    expect(first.texts('message')).toEqual(['hola mundo']);
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
      const { executions, harnessed } = await guarded(broker, { alice: ['nox.core.history.*'] });

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
    test('queues direction immediately after the active operation without aborting it', async () => {
      const broker = new TestBroker({ runs: true });
      const provider = new PausingProvider();
      const harnessed = await harness(await openDatabase(), broker, { provider });

      broker.say('chat-1', 'contame algo largo');
      await provider.firstPaused;
      broker.steer('chat-1', 'mejor no');
      await harnessed.gateway.drain();

      // The steer has been accepted while the first provider request remains live.
      expect(provider.firstAborted).toBeFalse();
      expect(finished(broker)).toHaveLength(0);

      provider.releaseFirst();
      await settle(harnessed);
      await waitFor(() => (finished(broker).length === 1 ? true : undefined), 'A finished run');

      const runs = broker.delivered.filter((event) => event.type === 'runStarted');
      expect(broker.texts('message')).toEqual(['termino esto', 'ahora lo nuevo']);
      expect(finished(broker).map((run) => run.status)).toEqual(['completed']);
      expect(runs.map((run) => run.trigger)).toEqual(['user']);
      expect(
        harnessed.application.sessions[0]?.session
          .getTranscript()
          .filter((message) => message.role === 'user')
          .map((message) => message.delivery),
      ).toEqual(['message', 'steer']);
    });

    test('steers an idle conversation, which is only talking', async () => {
      const broker = new TestBroker({ runs: true });
      const harnessed = await harness(await openDatabase(), broker);

      broker.steer('chat-1', 'hola');
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
      await broker.halt('chat-1');
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

      await broker.halt('chat-1', 'session');
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

      await broker.halt('chat-1');
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

      expect(await broker.invoke('chat-1', 'selfDestruct')).toEqual({ reason: 'unknownCommand' });
    });

    test('refuses arguments that do not fit, and says why', async () => {
      const broker = new TestBroker();
      const harnessed = await harness(await openDatabase(), broker);

      broker.say('chat-1', 'hola');
      await settle(harnessed);

      const rejection = await broker.invoke('chat-1', 'stop', { scope: 'everything' });

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
      expect(await broker.invoke('chat-1', 'stop')).toBeUndefined();
      await settle(harnessed);

      expect(finished(broker).map((run) => run.status)).toEqual(['aborted']);
      expect(harnessed.application.sessions).toHaveLength(1);
    });

    test('runs a contributed command with everything it needs and nothing more', async () => {
      const database = await openDatabase();
      const broker = new TestBroker({ commands: true });
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
            run: (context, { tags }) => {
              seen.push({
                conversationId: context.conversationId,
                sender: context.sender.subject,
                tags: [...tags],
              });
              return Promise.resolve({ text: `Tagged: ${tags.join(', ')}` });
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
      expect(
        await broker.invoke('chat-1', 'tag', { tags: ['urgent', 'done'] }, 'alice'),
      ).toBeUndefined();
      await harnessed.gateway.drain();

      expect(seen).toEqual([
        { conversationId: 'chat-1', sender: 'alice', tags: ['urgent', 'done'] },
      ]);
      expect(
        broker.delivered.find((event) => event.type === 'commandResult' && event.name === 'tag'),
      ).toMatchObject({
        name: 'tag',
        status: 'completed',
        text: 'Tagged: urgent, done',
        type: 'commandResult',
      });
      // A multiple choice is checked like anything else.
      expect((await broker.invoke('chat-1', 'tag', { tags: [] }))?.reason).toBe('invalidArguments');
      expect((await broker.invoke('chat-1', 'tag', { tags: ['nope'] }))?.reason).toBe(
        'invalidArguments',
      );
    });

    test('retries generation under the command sender without adding a command message', async () => {
      const database = await openDatabase();
      const broker = new TestBroker({ commands: true, runs: true });
      const application = new NoxApplication();
      applications.push(application);
      await application.start();
      application.addAgent(
        new Agent(database, new SayingProvider('again'), MODEL, {
          agentId: 'assistant',
          authorities: catalog,
          systemPrompt: 'system',
        }),
      );
      const gateway = new Gateway(application, {
        brokers: [{ agentId: 'assistant', broker, brokerId: 'test' }],
        commands: [
          brokerCommand({
            description: 'Retries generation.',
            name: 'retry',
            parameters: z.object({}),
            run: async (context) => {
              await context.retry();
              return { text: 'Retried.' };
            },
          }),
        ],
        database,
      });
      application.setGateway(gateway);
      await gateway.start();
      const harnessed = { application, broker, gateway };

      broker.say('chat-1', 'hello', undefined, 'alice');
      await settle(harnessed);
      expect(await broker.invoke('chat-1', 'retry', undefined, 'alice')).toBeUndefined();
      await gateway.drain();

      expect(application.sessions[0]?.session.getTranscript().map(({ role }) => role)).toEqual([
        'user',
        'assistant',
        'assistant',
      ]);
      let sawRetry = false;
      for await (const event of application.sessions[0]?.session.events ?? []) {
        if (event.type !== 'runStarted' || event.trigger !== 'retry') continue;
        sawRetry = true;
        expect(event).toMatchObject({
          authority: {
            principal: { issuer: 'test', subject: 'alice' },
            source: { type: 'command' },
          },
          trigger: 'retry',
          type: 'runStarted',
        });
        break;
      }
      expect(sawRetry).toBeTrue();
    });

    test('authorizes and gates an extension-contributed command before it runs', async () => {
      const database = await openDatabase();
      const broker = new TestBroker({ commands: true, permissions: true });
      let ran = false;
      const extension = bindExtensionManifest(
        {
          engines: { extensionApi: '^0.1.0', nox: '^0.1.0' },
          id: 'test.commands',
          main: 'extension.js',
          schemaVersion: 1,
          version: '0.1.0',
        },
        defineExtension({
          activate(context) {
            context.contributions.register(
              commands,
              'secure',
              defineCommand({
                authority: TEST_AUTHORITY,
                description: 'Runs only after authorization and approval.',
                parameters: z.object({ value: z.string() }),
                risk: () => ({ effects: ['write'] }),
                run: (_context, { value }) => {
                  ran = true;
                  return Promise.resolve({ text: `Stored ${value}.` });
                },
              }),
            );
          },
        }),
      );
      const application = new NoxApplication({ extensions: [extension] });
      applications.push(application);
      await application.start();
      application.addAgent(
        new Agent(database, new SayingProvider('ok'), MODEL, {
          agentId: 'assistant',
          authorities: catalog,
          gate: { defaultVerdict: 'escalate', escalationTimeoutMs: 5_000 },
          systemPrompt: 'system',
        }),
      );
      const authorization = new GrantAuthorizationProvider(
        'test',
        { alice: [TEST_AUTHORITY] },
        catalog,
      );
      const gateway = new Gateway(application, {
        brokers: [{ agentId: 'assistant', authorization, broker, brokerId: 'test' }],
        database,
      });
      application.setGateway(gateway);
      await gateway.start();
      const harnessed = { application, broker, gateway };

      broker.say('chat-1', 'hello', undefined, 'alice');
      await settle(harnessed);
      expect(await broker.invoke('chat-1', 'secure', { value: 'x' }, 'alice')).toBeUndefined();
      const permission = await waitFor(
        () => broker.delivered.find((event) => event.type === 'permission'),
        'A command permission request',
      );
      expect(ran).toBeFalse();
      broker.answer('chat-1', permission.request.requestId, 'alice', { approved: 'once' });
      await gateway.drain();

      expect(ran).toBeTrue();
      expect(
        broker.delivered.find((event) => event.type === 'commandResult' && event.name === 'secure'),
      ).toMatchObject({
        name: 'secure',
        status: 'completed',
        text: 'Stored x.',
        type: 'commandResult',
      });
    });

    test('hands a conversation to a fresh session instead of mixing agent transcripts', async () => {
      const database = await openDatabase();
      const broker = new TestBroker({ commands: true });
      const application = new NoxApplication();
      applications.push(application);
      await application.start();
      application.addAgent(
        new Agent(database, new SayingProvider('first'), MODEL, {
          agentId: 'first',
          authorities: catalog,
          systemPrompt: 'first',
        }),
      );
      application.addAgent(
        new Agent(database, new SayingProvider('second'), MODEL, {
          agentId: 'second',
          authorities: catalog,
          systemPrompt: 'second',
        }),
      );
      const gateway = new Gateway(application, {
        brokers: [{ agentId: 'first', broker, brokerId: 'test', selectableAgent: true }],
        commands: [
          brokerCommand({
            description: 'Switches agents.',
            name: 'agent',
            parameters: z.object({ agent: z.string() }),
            run: async (context, { agent }) => {
              const session = await context.switchAgent(agent);
              return { text: `Now using ${session.agentId}.` };
            },
          }),
        ],
        database,
      });
      application.setGateway(gateway);
      await gateway.start();
      const harnessed = { application, broker, gateway };

      broker.say('chat-1', 'first turn');
      await settle(harnessed);
      const previous = (await broker.sessions())[0];
      expect(previous?.agentId).toBe('first');

      expect(await broker.invoke('chat-1', 'agent', { agent: 'second' })).toBeUndefined();
      await gateway.drain();
      const replacement = (await broker.sessions())[0];
      expect(replacement?.agentId).toBe('second');
      expect(replacement?.sessionId).not.toBe(previous?.sessionId);

      broker.say('chat-1', 'second turn');
      await settle(harnessed);
      expect(broker.texts('message').slice(-1)).toEqual(['second']);
      expect(
        (await new SessionStore(database).load(previous?.sessionId ?? ''))?.messages,
      ).toHaveLength(2);
    });

    test('changes model by reopening the same transcript and persists the override', async () => {
      const database = await openDatabase();
      const broker = new TestBroker({ commands: true });
      const provider = new SayingProvider('ok');
      provider.addModelConfig({ ...MODEL, modelId: 'other-model' });
      const application = new NoxApplication();
      applications.push(application);
      await application.start();
      application.addAgent(
        new Agent(database, provider, MODEL, {
          agentId: 'assistant',
          authorities: catalog,
          systemPrompt: 'system',
        }),
      );
      const gateway = new Gateway(application, {
        brokers: [{ agentId: 'assistant', broker, brokerId: 'test' }],
        commands: [
          brokerCommand({
            description: 'Switches models.',
            name: 'model',
            parameters: z.object({ model: z.string() }),
            run: async (context, { model }) => {
              const session = await context.switchModel(model);
              return { text: `Now using ${session.modelId}.` };
            },
          }),
        ],
        database,
      });
      application.setGateway(gateway);
      await gateway.start();
      const harnessed = { application, broker, gateway };

      broker.say('chat-1', 'hello');
      await settle(harnessed);
      const before = (await broker.sessions())[0];

      expect(await broker.invoke('chat-1', 'model', { model: 'other-model' })).toBeUndefined();
      await gateway.drain();
      const after = (await broker.sessions())[0];
      expect(after?.sessionId).toBe(before?.sessionId);
      expect(application.sessions[0]?.session.modelId).toBe('other-model');

      await application.closeSession(after?.sessionId ?? '');
      broker.say('chat-1', 'again');
      await settle(harnessed);
      expect(application.sessions[0]?.session.modelId).toBe('other-model');
      expect(
        application.sessions[0]?.session
          .getTranscript()
          .filter((message) => message.role === 'user'),
      ).toHaveLength(2);
    });

    test('refuses command names that slash-command surfaces cannot carry', () => {
      expect(
        () =>
          new CommandCatalog([
            brokerCommand({
              description: 'Cannot be published.',
              name: 'Not.Portable',
              parameters: z.object({}),
              run: () => Promise.resolve(),
            }),
          ]),
      ).toThrow('must be 1-32 lowercase letters');
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
      await broker.halt('chat-1', 'session');
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
      expect(await broker.halt('never-spoken-in')).toBeUndefined();
      await harnessed.gateway.drain();

      expect(harnessed.application.sessions).toHaveLength(0);
    });

    test('refuses everything once the gateway is no longer running', async () => {
      const broker = new TestBroker();
      const harnessed = await harness(await openDatabase(), broker);

      broker.say('chat-1', 'hola');
      await settle(harnessed);
      await harnessed.gateway.stop();

      expect(await broker.halt('chat-1')).toEqual({ reason: 'unavailable' });
    });
  });
});
