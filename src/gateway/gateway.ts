import { nanoid } from 'nanoid';

import { type ConversationKey, ConversationStore } from '../database/conversationStore';
import { type Logger, silentLogger } from '../logger/logger';

import type { MessageContent } from '../agent/context/message';
import type { Session } from '../agent/session';
import type { NoxApplication } from '../application';
import type { AuthorizationProvider } from '../auth/authorization';
import type { MessageOrigin } from '../auth/principal';
import type { Database } from '../database/database';
import type { PermissionRequest, PermissionResolution } from '../tool/gate';
import type {
  Broker,
  InboundEvent,
  InboundMessage,
  InboundPermission,
  OutboundEvent,
} from './broker';

/** How many transport message ids one conversation remembers for deduplication. */
const SEEN_LIMIT = 256;

/** The complete route and ingress policy selected for one conversation. */
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
  database: Database;
  logger?: Logger;
}

/** What the application needs of a gateway: a way to silence the transports first. */
interface MessageGateway {
  stop(): Promise<void>;
}

/** One live conversation: its binding, its session, and the turn in flight. */
interface Conversation {
  readonly binding: BrokerConversationGrant;
  readonly grant: BrokerGrant;
  readonly key: ConversationKey;
  /** Transport message ids already handled, oldest first. */
  readonly seen: string[];
  readonly seenIds: Set<string>;
  readonly session: Session;
  turnId: string;
}

/** An outbound event minus the addressing the gateway is the one to fill in. */
interface PendingDelivery {
  readonly conversation: Conversation;
  readonly turnId: string;
}

type OutboundBody =
  | { readonly request: PermissionRequest; readonly type: 'permission' }
  | {
      readonly requestId: string;
      readonly resolution: PermissionResolution;
      readonly type: 'permissionResolved';
    }
  | { readonly text: string; readonly type: 'error' | 'fragment' | 'message' };

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
  readonly #conversations = new Map<string, Conversation>();
  readonly #grants: readonly BrokerGrant[];
  readonly #logger: Logger;
  /** Permission prompts in flight, with the originating turn they must retain. */
  readonly #pending = new Map<string, PendingDelivery>();
  readonly #store: ConversationStore;
  readonly #work = new Map<string, Promise<void>>();

  #state: 'created' | 'running' | 'stopped' = 'created';

  constructor(application: NoxApplication, options: GatewayOptions) {
    this.#application = application;
    this.#grants = Object.freeze([...options.brokers]);
    this.#logger = options.logger ?? silentLogger;
    this.#store = new ConversationStore(options.database);

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
        logger: this.#logger.child(grant.brokerId),
        receive: (event: InboundEvent): void => {
          this.#receive(grant, event);
        },
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
          await this.#handleMessage(grant, event);
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

  async #handleMessage(grant: BrokerGrant, message: InboundMessage): Promise<void> {
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

    conversation.session.send(text, origin);
    await this.#store.touch(conversation.key);
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
      binding,
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
   * Turns one session's events into what its transport can show. A broker
   * receives what it said it can render: the settled reply always, the reply as
   * it is being written only if it can edit what it already sent, a permission
   * request only if it can ask someone who is allowed to answer.
   */
  async #watch(conversation: Conversation): Promise<void> {
    const { broker } = conversation.grant;
    const streams = broker.capabilities.streaming === true;
    // Whether anyone may answer is no longer a property of the transport: the
    // one person who can is the principal whose run raised the request, and they
    // are by definition in this conversation. All that is left to ask is whether
    // the transport can put the question in front of them at all.
    const asks = broker.capabilities.permissions === true;

    for await (const event of conversation.session.events) {
      switch (event.type) {
        case 'runStarted':
          conversation.turnId = event.runId;
          break;
        case 'assistantTextFragment':
          if (streams) this.#deliver(conversation, { text: event.text, type: 'fragment' });
          break;
        case 'message': {
          if (event.message.role !== 'assistant') break;
          const text = textOf(event.message.content);
          if (text.length > 0) this.#deliver(conversation, { text, type: 'message' });
          break;
        }
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
        case 'error':
          this.#deliver(conversation, { text: event.error.message, type: 'error' });
          break;
        case 'assistantReasoningFragment':
        case 'authorizationDecided':
        case 'retry':
        case 'runCompleted':
        case 'usage':
          break;
      }
    }
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
