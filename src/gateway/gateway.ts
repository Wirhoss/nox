import { nanoid } from 'nanoid';

import { type ConversationKey, ConversationStore } from '../database/conversationStore';
import { type Logger, silentLogger } from '../logger/logger';

import type { MessageContent } from '../agent/context/message';
import type { Session } from '../agent/session';
import type { NoxApplication } from '../application';
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

/** A configured broker instance: the transport, and who answers on it. */
interface BrokerGrant {
  readonly agentId: string;
  /** Sender ids allowed to answer a permission request. Empty means nobody. */
  readonly approvers?: readonly string[];
  readonly broker: Broker;
  readonly brokerId: string;
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
  readonly grant: BrokerGrant;
  readonly key: ConversationKey;
  /** Transport message ids already handled, oldest first. */
  readonly seen: string[];
  readonly seenIds: Set<string>;
  readonly session: Session;
  turnId: string;
}

/** An outbound event minus the addressing the gateway is the one to fill in. */
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
  /** Permission requests in flight, so an answer finds the session that asked. */
  readonly #pending = new Map<string, Conversation>();
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
    const conversation = await this.#attach(grant, message.conversationId);

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

    const text = message.text.trim();
    if (text.length === 0) return;

    conversation.session.send(text);
    await this.#store.touch(conversation.key);
  }

  /**
   * An answer to a permission request. A transport asserts who is speaking; it
   * does not decide who may approve, so the sender has to be one the broker's
   * configuration named, and the request has to be one this conversation's own
   * session is waiting on.
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

    if (!(grant.approvers ?? []).includes(event.senderId)) {
      this.#logger.warn(
        { brokerId: grant.brokerId, requestId: event.requestId, senderId: event.senderId },
        'A permission answer arrived from someone who is not an approver.',
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

    conversation.session.resolvePermission(event.requestId, event.resolution);
  }

  /**
   * The session a conversation is. Bound once and read forever after: the same
   * chat reopens the same transcript, including across a restart.
   */
  async #attach(grant: BrokerGrant, conversationId: string): Promise<Conversation> {
    const mapKey = keyOf(grant.brokerId, conversationId);
    const live = this.#conversations.get(mapKey);
    // A session stopped from another surface leaves the binding intact; the next
    // message reopens it rather than starting the conversation over.
    if (live !== undefined && live.session.state !== 'stopped') return live;
    this.#conversations.delete(mapKey);

    const key: ConversationKey = { brokerId: grant.brokerId, conversationId };
    const bound = await this.#store.find(key);
    if (bound !== undefined && bound.agentId !== grant.agentId) {
      throw new Error(
        `Conversation ${conversationId} on broker ${grant.brokerId} belongs to agent ` +
          `${bound.agentId}, but the broker is now configured for ${grant.agentId}.`,
      );
    }

    const session = await this.#application.openSession(grant.agentId, {
      metadata: { brokerId: grant.brokerId, conversationId },
      sessionId: bound?.sessionId,
      title: `${grant.brokerId}:${conversationId}`,
    });

    if (bound === undefined) await this.#store.bind(key, grant.agentId, session.sessionId);

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

  /**
   * Turns one session's events into what its transport can show. A broker
   * receives what it said it can render: the settled reply always, the reply as
   * it is being written only if it can edit what it already sent, a permission
   * request only if it can ask someone who is allowed to answer.
   */
  async #watch(conversation: Conversation): Promise<void> {
    const { broker } = conversation.grant;
    const streams = broker.capabilities.streaming === true;
    const asks =
      broker.capabilities.permissions === true && (conversation.grant.approvers ?? []).length > 0;

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
          this.#pending.set(event.request.requestId, conversation);
          this.#deliver(conversation, { request: event.request, type: 'permission' });
          break;
        case 'permissionResolved':
          if (this.#pending.delete(event.requestId) && asks) {
            this.#deliver(conversation, {
              requestId: event.requestId,
              resolution: event.resolution,
              type: 'permissionResolved',
            });
          }
          break;
        case 'error':
          this.#deliver(conversation, { text: event.error.message, type: 'error' });
          break;
        case 'assistantReasoningFragment':
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
  #deliver(conversation: Conversation, body: OutboundBody): void {
    // A run still finishing during shutdown has nowhere to go: the transport was
    // already told to stop, and handing it more is asking a closed socket to
    // speak.
    if (this.#state !== 'running') return;

    const event: OutboundEvent = {
      ...body,
      conversationId: conversation.key.conversationId,
      turnId: conversation.turnId,
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

export type { BrokerGrant, GatewayOptions, MessageGateway };
