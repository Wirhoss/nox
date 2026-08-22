import { nanoid } from 'nanoid';

import { type ConversationKey, ConversationStore } from '../database/conversationStore';
import { SessionStore } from '../database/sessionStore';
import { type Logger, silentLogger } from '../logger/logger';
import {
  type BrokerCommand,
  type BrokerCommandSpec,
  BUILTIN_COMMANDS,
  CommandCatalog,
  type CommandContext,
  type CommandInvocation,
  type CommandRejection,
} from './command';

import type { Message, MessageContent } from '../agent/context/message';
import type { Session } from '../agent/session';
import type { NoxApplication } from '../application';
import type { AuthorizationProvider } from '../auth/authorization';
import type { MessageOrigin } from '../auth/principal';
import type { Database } from '../database/database';
import type {
  Broker,
  BrokerCapabilities,
  BrokerHistory,
  BrokerHistoryEntry,
  BrokerHistoryOptions,
  BrokerSession,
  InboundEvent,
  InboundMessage,
  InboundPermission,
  InboundSteer,
  MessageBody,
  OutboundBody,
  OutboundEvent,
} from './broker';

/** How many transport message ids one conversation remembers for deduplication. */
const SEEN_LIMIT = 256;

/** The complete agent route and authorization policy for one conversation. */
interface BrokerConversationGrant {
  readonly agentId: string;
  /** Absent is not permissive: a session without one authorizes nothing. */
  readonly authorization?: AuthorizationProvider;
}

/** A configured broker instance and its base/per-conversation routes. */
interface BrokerGrant extends BrokerConversationGrant {
  readonly broker: Broker;
  readonly brokerId: string;
  readonly conversations?: Readonly<Record<string, BrokerConversationGrant>>;
}

interface GatewayOptions {
  brokers: readonly BrokerGrant[];
  /**
   * Commands on top of the built-in ones. A name that already exists is a
   * configuration error rather than an override: a transport rendered `stop`
   * from the catalog, and a deployment quietly redefining what it does is the
   * one thing a declared vocabulary is supposed to prevent.
   */
  commands?: readonly BrokerCommand[];
  database: Database;
  logger?: Logger;
}

/** What the application needs of a gateway: a way to silence the transports first. */
interface MessageGateway {
  stop(): Promise<void>;
}

/** One live conversation: its binding, its session, and the turn in flight. */
interface Conversation {
  readonly grant: BrokerGrant;
  readonly key: ConversationKey;
  /** Transport message ids already handled, oldest first. */
  readonly seen: string[];
  readonly seenIds: Set<string>;
  readonly session: Session;
  turnId: string;
}

/** A permission prompt in flight, and the turn its retraction must carry. */
interface PendingDelivery {
  readonly conversation: Conversation;
  readonly turnId: string;
}

/** Whether a transport asked for this kind of event. Absent is never permissive. */
function shows(broker: Broker, capability: keyof BrokerCapabilities): boolean {
  return broker.capabilities[capability] === true;
}

function keyOf(brokerId: string, conversationId: string): string {
  return `${brokerId} ${conversationId}`;
}

function textOf(content: readonly MessageContent[]): string {
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
}

/**
 * One stored message in the vocabulary a transport speaks, or nothing when it
 * never asked for that kind of thing. The live stream and a transcript read back
 * both come through here, so scrolling up shows the same conversation watching
 * it would have — one place decides what a surface sees, not two.
 */
function bodyOf(broker: Broker, message: Message): MessageBody | undefined {
  switch (message.role) {
    case 'assistant': {
      const text = textOf(message.content);
      return text.length === 0 ? undefined : { text, type: 'message' };
    }
    case 'compacted':
      return shows(broker, 'contextChanges')
        ? {
            change: 'compacted',
            replacedMessageIds: message.compactedMessageIds,
            text: textOf(message.content),
            type: 'contextChange',
          }
        : undefined;
    case 'folded':
      return shows(broker, 'contextChanges')
        ? {
            change: 'folded',
            replacedMessageIds: message.foldedMessageIds,
            text: textOf(message.content),
            type: 'contextChange',
          }
        : undefined;
    case 'reasoning':
      return shows(broker, 'reasoning')
        ? { text: textOf(message.content), type: 'reasoning' }
        : undefined;
    case 'toolCall':
      return shows(broker, 'toolActivity')
        ? {
            arguments: message.arguments,
            name: message.name,
            trackId: message.trackId,
            type: 'toolCall',
          }
        : undefined;
    case 'toolResponse':
      return shows(broker, 'toolActivity')
        ? {
            execution: message.execution,
            isError: message.isError === true,
            name: message.name,
            text: textOf(message.response),
            trackId: message.trackId,
            type: 'toolResponse',
          }
        : undefined;
    case 'user':
      // Whether a transport sees what another participant said is about who may
      // see it, not about what can be drawn — so nothing about it is decided by
      // a capability, and the live stream does not carry it at all.
      return undefined;
  }
}

/**
 * One stored message as a transcript entry. This is the one place a user message
 * crosses: a conversation read back by the transport that owns it is not a
 * broadcast, and half a transcript is not a transcript.
 */
function historyEntry(broker: Broker, message: Message): BrokerHistoryEntry | undefined {
  const at = message.createdAt;
  const { messageId } = message;

  if (message.role === 'user') {
    return {
      at,
      messageId,
      principal: message.origin.principal,
      text: textOf(message.content),
      type: 'userMessage',
    };
  }

  const body = bodyOf(broker, message);
  return body === undefined ? undefined : { ...body, at, messageId };
}

/**
 * The message gateway: conversations on transports, answered by agents.
 *
 * Everything between a transport and a session lives here — which agent answers
 * a chat, which session that chat is, whether it is a new one or the one it was
 * already having, and what of a run is worth sending back. Brokers know none of
 * it, and an agent knows nothing about transports; the binding between the two
 * is a row in storage, which is what lets a conversation survive a restart with
 * its transcript rather than starting over.
 *
 * Work is serialized per conversation. Two messages arriving together are two
 * turns of one session, never two sessions racing to be the one that chat is.
 */
class Gateway implements MessageGateway {
  readonly #application: NoxApplication;
  readonly #commands: CommandCatalog;
  readonly #conversations = new Map<string, Conversation>();
  readonly #grants: readonly BrokerGrant[];
  readonly #logger: Logger;
  /** Permission prompts in flight, with the originating turn they must retain. */
  readonly #pending = new Map<string, PendingDelivery>();
  readonly #store: ConversationStore;
  /**
   * Transcripts of conversations that are not open. Read-only by construction:
   * a session owns exactly one store, and a second one that appended would
   * restart the sequence and collide with every row already written.
   */
  readonly #transcripts: SessionStore;
  readonly #work = new Map<string, Promise<void>>();

  #state: 'created' | 'running' | 'stopped' = 'created';

  constructor(application: NoxApplication, options: GatewayOptions) {
    this.#application = application;
    this.#commands = new CommandCatalog([...BUILTIN_COMMANDS, ...(options.commands ?? [])]);
    this.#grants = Object.freeze([...options.brokers]);
    this.#logger = options.logger ?? silentLogger;
    this.#store = new ConversationStore(options.database);
    this.#transcripts = new SessionStore(options.database, { logger: this.#logger });

    const ids = new Set<string>();
    for (const grant of this.#grants) {
      if (ids.has(grant.brokerId)) {
        throw new Error(`Broker "${grant.brokerId}" is configured more than once.`);
      }
      ids.add(grant.brokerId);
    }
  }

  public get brokerIds(): readonly string[] {
    return Object.freeze(
      this.#grants.map((grant) => grant.brokerId).sort((a, b) => a.localeCompare(b)),
    );
  }

  /** Every command this Nox offers, in the shape a transport renders. */
  public get commands(): readonly BrokerCommandSpec[] {
    return this.#commands.specs;
  }

  public get state(): 'created' | 'running' | 'stopped' {
    return this.#state;
  }

  /**
   * Starts every transport. A broker that fails to start takes the gateway with
   * it: a Nox that came up believing it is reachable on a channel it never
   * connected to is worse than one that refused to start.
   */
  public async start(): Promise<void> {
    if (this.#state !== 'created') {
      throw new Error(`The gateway cannot start while it is ${this.#state}.`);
    }
    this.#state = 'running';

    for (const grant of this.#grants) {
      await grant.broker.start({
        command: (invocation: CommandInvocation): CommandRejection | undefined =>
          this.#command(grant, invocation),
        commands: this.#commands.specs,
        history: (
          conversationId: string,
          options?: BrokerHistoryOptions,
        ): Promise<BrokerHistory | undefined> => this.#history(grant, conversationId, options),
        logger: this.#logger.child(grant.brokerId),
        receive: (event: InboundEvent): void => {
          this.#receive(grant, event);
        },
        sessions: (): Promise<readonly BrokerSession[]> => this.#sessions(grant),
        signal: this.#application.signal,
      });
    }
  }

  /**
   * Silences every transport. Sessions are not closed here — the application
   * owns them, and closing them is what it does next; a broker that stopped
   * first simply has nothing left to deliver to.
   */
  public async stop(): Promise<void> {
    if (this.#state === 'stopped') return;
    this.#state = 'stopped';

    for (const grant of [...this.#grants].reverse()) {
      try {
        await grant.broker.stop();
      } catch (error) {
        this.#logger.error({ brokerId: grant.brokerId, err: error }, 'Broker failed to stop.');
      }
    }

    this.#conversations.clear();
    this.#pending.clear();
  }

  /** Resolves once everything queued for every conversation has settled. */
  public async drain(): Promise<void> {
    while (this.#work.size > 0) {
      await Promise.all([...this.#work.values()]);
    }
  }

  /**
   * What a broker calls. It returns immediately and never throws: a transport
   * handing over what arrived is not where a session's failure is handled.
   */
  #receive(grant: BrokerGrant, event: InboundEvent): void {
    if (this.#state !== 'running') return;

    this.#queue(keyOf(grant.brokerId, event.conversationId), async () => {
      switch (event.type) {
        case 'message':
        case 'steer':
          await this.#handleSpeech(grant, event);
          break;
        case 'permission':
          this.#handlePermission(grant, event);
          break;
      }
    });
  }

  /** Chains work per conversation, so nothing about one chat runs twice at once. */
  #queue(key: string, task: () => Promise<void>): void {
    const previous = this.#work.get(key) ?? Promise.resolve();
    const next: Promise<void> = previous
      .then(task)
      .catch((error: unknown) => {
        this.#logger.error({ conversation: key, err: error }, 'Gateway failed to handle an event.');
      })
      .then(() => {
        // Only the last link clears the chain; an earlier one finishing while
        // more is queued would let the next event start beside it.
        if (this.#work.get(key) === next) this.#work.delete(key);
      });
    this.#work.set(key, next);
  }

  /**
   * Something said into a conversation, and the two ways of saying it. A message
   * waits for the run in flight; a steer cuts it short and speaks over it. Every
   * step before that last one is the same, because interrupting is still someone
   * talking: it is attributed, deduplicated and serialized like anything else.
   */
  async #handleSpeech(grant: BrokerGrant, message: InboundMessage | InboundSteer): Promise<void> {
    const text = message.text.trim();
    if (text.length === 0) return;

    const binding = this.#bindingFor(grant, message.conversationId);
    const conversation = await this.#attach(grant, binding, message.conversationId);

    // A transport that retries a delivery must not produce a second turn. This
    // is remembered per live conversation, not stored: a duplicate arriving
    // after a restart is indistinguishable from a real message, and pretending
    // otherwise would need a table of every id a chat has ever sent.
    if (conversation.seenIds.has(message.messageId)) {
      this.#logger.debug(
        { brokerId: grant.brokerId, messageId: message.messageId },
        'Dropped a message that was already handled.',
      );
      return;
    }
    conversation.seenIds.add(message.messageId);
    conversation.seen.push(message.messageId);
    if (conversation.seen.length > SEEN_LIMIT) {
      const evicted = conversation.seen.shift();
      if (evicted !== undefined) conversation.seenIds.delete(evicted);
    }

    // The identity the broker authenticated, carried in rather than dropped
    // here: it is what attributes the message, and what the run it starts will
    // act under. The issuer is the broker's configured ID, because a sender ID
    // only means something relative to the transport that vouched for it.
    const origin: MessageOrigin = {
      principal: { issuer: grant.brokerId, subject: message.senderId },
      transportMessageId: message.messageId,
    };

    if (message.type === 'steer') {
      await conversation.session.steer(text, origin);
    } else {
      conversation.session.send(text, origin);
    }
    await this.#store.touch(conversation.key);
  }

  /**
   * Invokes a command.
   *
   * Two halves, and the split is the whole point. Checking is synchronous and
   * answers the only things a client can act on — a command that does not exist,
   * arguments that do not fit — against the same declaration it rendered from.
   * Running is queued behind whatever else that conversation has going, like a
   * message, because a command that waited its turn is a command that cannot
   * race the run it is about.
   */
  #command(grant: BrokerGrant, invocation: CommandInvocation): CommandRejection | undefined {
    if (this.#state !== 'running') return { reason: 'unavailable' };

    const checked = this.#commands.check(invocation);
    if ('rejection' in checked) return checked.rejection;

    this.#queue(keyOf(grant.brokerId, invocation.conversationId), () =>
      this.#runCommand(grant, invocation, checked.command, checked.args),
    );
    return undefined;
  }

  /**
   * One command, in the conversation it names. Commands act on an open chat:
   * there is nothing to stop in one nobody is having, and a bound-but-closed one
   * is already as stopped as stopping would make it.
   */
  async #runCommand(
    grant: BrokerGrant,
    invocation: CommandInvocation,
    command: BrokerCommand,
    args: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const mapKey = keyOf(grant.brokerId, invocation.conversationId);
    const conversation = this.#conversations.get(mapKey);
    if (conversation === undefined) {
      this.#logger.warn(
        {
          brokerId: grant.brokerId,
          command: command.name,
          conversationId: invocation.conversationId,
        },
        'A command arrived for a conversation that is not open.',
      );
      return;
    }

    const context: CommandContext = {
      close: async (): Promise<void> => {
        this.#conversations.delete(mapKey);
        // Closing resolves whatever the gate was still holding, and those
        // outcomes are delivered on the way down; only then is there nothing
        // left to retract.
        await this.#application.closeSession(conversation.session.sessionId);
        for (const [requestId, pending] of this.#pending) {
          if (pending.conversation === conversation) this.#pending.delete(requestId);
        }
      },
      conversationId: invocation.conversationId,
      logger: this.#logger.child(`${grant.brokerId}:${command.name}`),
      sender: { issuer: grant.brokerId, subject: invocation.senderId },
      session: conversation.session,
    };

    await command.run(context, args);
  }

  /**
   * An answer to a permission request. It is a structured event, never a message:
   * "yes", "dale" and "approve" typed into the chat are words the model reads,
   * and nothing a person says in prose resolves a pending call.
   *
   * A transport asserts who is speaking; it does not decide who may approve. The
   * request has to belong to this conversation's own session, has to still be
   * pending, and the sender has to be the principal whose run raised it — which
   * the gate re-checks, along with expiry, before it lets the call through.
   */
  #handlePermission(grant: BrokerGrant, event: InboundPermission): void {
    const conversation = this.#conversations.get(keyOf(grant.brokerId, event.conversationId));
    if (conversation === undefined) {
      this.#logger.warn(
        { brokerId: grant.brokerId, conversationId: event.conversationId },
        'A permission answer arrived for a conversation that is not open.',
      );
      return;
    }

    const waiting = conversation.session
      .getPendingPermissions()
      .some((request) => request.requestId === event.requestId);
    if (!waiting) {
      this.#logger.warn(
        { brokerId: grant.brokerId, requestId: event.requestId },
        'A permission answer arrived for a request this session is not waiting on.',
      );
      return;
    }

    const resolved = conversation.session.resolvePermission(event.requestId, event.resolution, {
      issuer: grant.brokerId,
      subject: event.senderId,
    });
    if (!resolved) {
      this.#logger.warn(
        { brokerId: grant.brokerId, requestId: event.requestId, senderId: event.senderId },
        'Refused a permission answer: only the principal that started the run may answer it.',
      );
    }
  }

  /**
   * A conversation read back, as much of it as this transport can show.
   *
   * It answers from the live session when there is one and from storage when
   * there is not, and reading never opens one: a surface asking what was said in
   * a chat is not the same as someone speaking in it, and answering a question
   * by waking an agent would make scrolling a transcript start runs.
   */
  async #history(
    grant: BrokerGrant,
    conversationId: string,
    options: BrokerHistoryOptions = {},
  ): Promise<BrokerHistory | undefined> {
    const bound = await this.#store.find({ brokerId: grant.brokerId, conversationId });
    if (bound === undefined) return undefined;

    const live = this.#conversations.get(keyOf(grant.brokerId, conversationId));
    const messages =
      live?.session.getTranscript() ??
      (await this.#transcripts.load(bound.sessionId))?.messages ??
      [];

    const entries: BrokerHistoryEntry[] = [];
    for (const message of messages) {
      const entry = historyEntry(grant.broker, message);
      if (entry !== undefined) entries.push(entry);
    }

    const { limit } = options;
    return {
      agentId: bound.agentId,
      contextUsage: live?.session.getContextUsage(),
      conversationId,
      entries: limit === undefined ? entries : limit <= 0 ? [] : entries.slice(-limit),
      sessionId: bound.sessionId,
    };
  }

  /**
   * What this transport is carrying. The list is the bindings rather than the
   * live sessions: a chat nobody has spoken in since the last restart is still a
   * conversation, and one missing from the list would look deleted.
   */
  async #sessions(grant: BrokerGrant): Promise<readonly BrokerSession[]> {
    const rows = await this.#store.list(grant.brokerId);

    return Object.freeze(
      rows.map((row): BrokerSession => {
        const live = this.#conversations.get(keyOf(grant.brokerId, row.conversationId));
        // A session held here but stopped is closed as far as anyone asking is
        // concerned; the next message reopens it like any other binding.
        const state = live?.session.state;
        return {
          agentId: row.agentId,
          contextUsage: live?.session.getContextUsage(),
          conversationId: row.conversationId,
          sessionId: row.sessionId,
          startedAt: new Date(row.createdAt),
          state: state === undefined || state === 'stopped' ? 'closed' : state,
          updatedAt: new Date(row.updatedAt),
        };
      }),
    );
  }

  /**
   * The session a conversation is. Bound once and read forever after: the same
   * chat reopens the same transcript, including across a restart.
   */
  async #attach(
    grant: BrokerGrant,
    binding: BrokerConversationGrant,
    conversationId: string,
  ): Promise<Conversation> {
    const mapKey = keyOf(grant.brokerId, conversationId);
    const live = this.#conversations.get(mapKey);
    // A session stopped from another surface leaves the binding intact; the next
    // message reopens it rather than starting the conversation over.
    if (live !== undefined && live.session.state !== 'stopped') return live;
    this.#conversations.delete(mapKey);

    const key: ConversationKey = { brokerId: grant.brokerId, conversationId };
    const bound = await this.#store.find(key);
    if (bound !== undefined && bound.agentId !== binding.agentId) {
      throw new Error(
        `Conversation ${conversationId} on broker ${grant.brokerId} belongs to agent ` +
          `${bound.agentId}, but it is now configured for ${binding.agentId}. ` +
          'Delete its persisted binding to start a new session explicitly.',
      );
    }

    const session = await this.#application.openSession(binding.agentId, {
      authorization: binding.authorization,
      metadata: { brokerId: grant.brokerId, conversationId },
      sessionId: bound?.sessionId,
      title: `${grant.brokerId}:${conversationId}`,
    });

    if (bound === undefined) await this.#store.bind(key, binding.agentId, session.sessionId);

    const conversation: Conversation = {
      grant,
      key,
      seen: [],
      seenIds: new Set<string>(),
      session,
      turnId: nanoid(),
    };
    this.#conversations.set(mapKey, conversation);
    void this.#watch(conversation);
    return conversation;
  }

  #bindingFor(grant: BrokerGrant, conversationId: string): BrokerConversationGrant {
    return grant.conversations?.[conversationId] ?? grant;
  }

  /**
   * Turns one session's events into what its transport can show.
   *
   * Every event a run produces is offered here, and what leaves is what the
   * broker declared it renders. That split is the point: whether reasoning,
   * tool activity or token counts belong on a surface is a question about the
   * surface, and a gateway answering it for everyone would be doing product
   * design for transports it has never seen.
   *
   * Two things stay behind, and neither is about rendering. What another
   * participant said, and which principal was allowed to use which authority,
   * are questions about who may see what.
   */
  async #watch(conversation: Conversation): Promise<void> {
    const { broker } = conversation.grant;
    // Whether anyone may answer is no longer a property of the transport: the
    // one person who can is the principal whose run raised the request, and they
    // are by definition in this conversation. All that is left to ask is whether
    // the transport can put the question in front of them at all.
    const asks = shows(broker, 'permissions');

    for await (const event of conversation.session.events) {
      switch (event.type) {
        case 'assistantReasoningFragment':
          // A fragment is a thing being written. A transport that cannot show
          // one being written has no use for it, however much reasoning it wants.
          if (shows(broker, 'reasoning') && shows(broker, 'streaming')) {
            this.#deliver(conversation, { text: event.text, type: 'reasoningFragment' });
          }
          break;
        case 'assistantTextFragment':
          if (shows(broker, 'streaming')) {
            this.#deliver(conversation, { text: event.text, type: 'fragment' });
          }
          break;
        case 'authorizationDecided':
          // Not a rendering question: it names a principal and the grant that
          // matched, which is audit rather than conversation.
          break;
        case 'error':
          this.#deliver(conversation, { text: event.error.message, type: 'error' });
          break;
        case 'message':
          this.#deliverMessage(conversation, event.message);
          this.#deliverContextUsage(conversation);
          break;
        case 'permissionRequested':
          if (!asks) break;
          this.#pending.set(event.request.requestId, {
            conversation,
            turnId: event.request.runId,
          });
          this.#deliver(
            conversation,
            { request: event.request, type: 'permission' },
            event.request.runId,
          );
          break;
        case 'permissionResolved': {
          const pending = this.#pending.get(event.requestId);
          if (pending?.conversation === conversation && asks) {
            this.#pending.delete(event.requestId);
            this.#deliver(
              conversation,
              {
                requestId: event.requestId,
                resolution: event.resolution,
                type: 'permissionResolved',
              },
              pending.turnId,
            );
          }
          break;
        }
        case 'retry':
          if (shows(broker, 'retries')) {
            this.#deliver(conversation, {
              attempt: event.attempt,
              delayMs: event.delayMs,
              text: event.error.message,
              type: 'retry',
            });
          }
          break;
        case 'runCompleted':
          if (shows(broker, 'runs')) {
            this.#deliver(
              conversation,
              {
                durationMs: event.durationMs,
                status: event.status,
                type: 'runCompleted',
                // The total belongs to the run, but it is token accounting
                // either way: a transport that did not ask does not get it.
                usage: shows(broker, 'usage') ? event.usage : undefined,
              },
              event.runId,
            );
          }
          break;
        case 'runStarted':
          conversation.turnId = event.runId;
          if (shows(broker, 'runs')) {
            this.#deliver(conversation, {
              modelId: event.modelId,
              startedAt: event.startedAt,
              trigger: event.trigger,
              type: 'runStarted',
            });
          }
          break;
        case 'usage':
          if (shows(broker, 'usage')) {
            this.#deliver(conversation, { usage: event.usage, type: 'usage' });
          }
          this.#deliverContextUsage(conversation);
          break;
      }
    }
  }

  /** One appended message, as much of it as this transport takes. */
  #deliverMessage(conversation: Conversation, message: Message): void {
    const body = bodyOf(conversation.grant.broker, message);
    if (body !== undefined) this.#deliver(conversation, body);
  }

  #deliverContextUsage(conversation: Conversation): void {
    if (!shows(conversation.grant.broker, 'contextUsage')) return;
    this.#deliver(conversation, {
      type: 'contextUsage',
      usage: conversation.session.getContextUsage(),
    });
  }

  /**
   * Hands one event to a transport. A delivery that fails is logged and dropped:
   * the transcript already holds the reply, and a session does not end because a
   * chat service was briefly unreachable.
   */
  #deliver(conversation: Conversation, body: OutboundBody, turnId = conversation.turnId): void {
    // A run still finishing during shutdown has nowhere to go: the transport was
    // already told to stop, and handing it more is asking a closed socket to
    // speak.
    if (this.#state !== 'running') return;

    const event: OutboundEvent = {
      ...body,
      conversationId: conversation.key.conversationId,
      turnId,
    };

    void conversation.grant.broker.deliver(event).catch((error: unknown) => {
      this.#logger.error(
        {
          brokerId: conversation.key.brokerId,
          conversationId: conversation.key.conversationId,
          err: error,
          event: event.type,
        },
        'Broker failed to deliver an event.',
      );
    });
  }
}

export { Gateway };

export type { BrokerConversationGrant, BrokerGrant, GatewayOptions, MessageGateway };
