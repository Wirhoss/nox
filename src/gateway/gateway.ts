import {
  type ArtifactScope,
  type Broker,
  type BrokerCapabilities,
  type BrokerCommandSpec,
  type BrokerHistory,
  type BrokerHistoryEntry,
  type BrokerHistoryOptions,
  type BrokerSession,
  type CommandContext,
  commands as commandContributions,
  type CommandInvocation,
  type CommandRejection,
  hasUsableContent,
  type InboundEvent,
  type InboundMessage,
  type InboundObservation,
  type InboundPermission,
  type InboundRejection,
  type InboundSteer,
  type Message,
  type MessageBody,
  type MessageContent,
  type MessageOrigin,
  type OutboundBody,
  type OutboundEvent,
  type ScheduledRunDelivery,
  type ScheduledRunHost,
  type ScheduledRunRequest,
  type ScheduledRunResult,
  textFromContent,
} from '@nox/extension-api';
import { nanoid } from 'nanoid';

import { artifactConversationScope } from '../artifact/output';
import { type ConversationKey, ConversationStore } from '../database/conversationStore';
import { SessionStore } from '../database/sessionStore';
import { type Logger, silentLogger } from '../logger/logger';
import { type BrokerCommand, BUILTIN_COMMANDS, CommandCatalog } from './command';

import type { AgentEvent, RunStatus } from '../agent/events';
import type { Session } from '../agent/session';
import type { NoxApplication } from '../application';
import type { AuthorizationProvider } from '../auth/authorization';
import type { Database } from '../database/database';

/** How many transport message ids one conversation remembers for deduplication. */
const SEEN_LIMIT = 256;

/** The complete agent route and authorization policy for one conversation. */
interface BrokerConversationGrant {
  /** Optional only for a surface that asks which agent should bind a new conversation. */
  readonly agentId?: string;
  /** Absent is not permissive: a session without one authorizes nothing. */
  readonly authorization?: AuthorizationProvider;
}

/** A configured broker instance and its base/per-conversation routes. */
interface BrokerGrant extends BrokerConversationGrant {
  readonly broker: Broker;
  readonly brokerId: string;
  readonly conversations?: Readonly<Record<string, BrokerConversationGrant>>;
  /** Whether this transport may carry an explicit agent route from its trusted UI. */
  readonly selectableAgent?: boolean;
}

interface GatewayOptions {
  brokers: readonly BrokerGrant[];
  brokerStatus?: (brokerId: string, state: 'active' | 'failed', error?: string) => void;
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
  return textFromContent(content).trim();
}

interface ScheduledCompletion {
  readonly completedAt: Date;
  readonly error?: string;
  readonly runId: string;
  readonly startedAt: Date;
  readonly status: RunStatus;
}

async function scheduledCompletion(
  events: AsyncIterable<AgentEvent>,
): Promise<ScheduledCompletion> {
  let error: string | undefined;
  let started: Extract<AgentEvent, { type: 'runStarted' }> | undefined;
  for await (const event of events) {
    if (event.type === 'error') error = event.error.message;
    if (event.type === 'runStarted') started = event;
    if (event.type === 'runCompleted') {
      if (started === undefined) throw new Error('Scheduled run completed before it started.');
      return {
        completedAt: new Date(started.startedAt.getTime() + event.durationMs),
        ...(error === undefined ? {} : { error }),
        runId: event.runId,
        startedAt: started.startedAt,
        status: event.status,
      };
    }
  }
  throw new Error('Scheduled session closed without a run result.');
}

/**
 * One stored message in the vocabulary a transport speaks, or nothing when it
 * never asked for that kind of thing. Live stream and transcript reads both
 * come through here, so one place decides what a surface sees.
 */
function bodyOf(broker: Broker, message: Message): MessageBody | undefined {
  switch (message.role) {
    case 'assistant': {
      const text = textOf(message.content);
      return hasUsableContent(message.content)
        ? { content: message.content, text, type: 'message' }
        : undefined;
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
            content: message.response,
            isError: message.isError === true,
            name: message.name,
            text: textOf(message.response),
            trackId: message.trackId,
            type: 'toolResponse',
          }
        : undefined;
    case 'user':
      // Whether a transport sees another participant's speech is a question of
      // who may see it, not of what can be drawn — no capability decides it.
      return undefined;
  }
}

/**
 * One stored message as a transcript entry. This is the one place a user message
 * crosses to the transport that owns it: a conversation read back by that
 * transport is not a broadcast, and half a transcript is not a transcript.
 */
function historyEntry(broker: Broker, message: Message): BrokerHistoryEntry | undefined {
  const at = message.createdAt;
  const { messageId } = message;

  if (message.role === 'user') {
    return {
      at,
      messageId,
      content: message.content,
      mode: message.delivery ?? 'message',
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
 * Everything between a transport and a session lives here — which agent answers
 * a chat, which session that chat is, and what of a run is worth sending back.
 * Brokers know none of it and an agent knows nothing about transports; the
 * binding is a row in storage, which is what lets a conversation survive a
 * restart with its transcript rather than starting over. Work is serialized per
 * conversation: two messages arriving together are two turns of one session,
 * never two sessions racing to be the one that chat is.
 */
class Gateway implements MessageGateway, ScheduledRunHost {
  readonly #activeBrokers = new Set<string>();
  readonly #application: NoxApplication;
  readonly #brokerStatus?: GatewayOptions['brokerStatus'];
  readonly #commands: CommandCatalog;
  readonly #conversations = new Map<string, Conversation>();
  readonly #grants = new Map<string, BrokerGrant>();
  readonly #logger: Logger;
  /** Permission prompts in flight, with the originating turn they must retain. */
  readonly #pending = new Map<string, PendingDelivery>();
  readonly #scheduledAbort = new AbortController();
  readonly #scheduledWork = new Set<Promise<ScheduledRunResult>>();
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
    this.#brokerStatus = options.brokerStatus;
    const contributed: BrokerCommand[] = application.contributions
      .list(commandContributions)
      .map(({ id, value }) => ({ ...value, name: id }));
    this.#commands = new CommandCatalog([
      ...BUILTIN_COMMANDS,
      ...contributed,
      ...(options.commands ?? []),
    ]);
    this.#logger = options.logger ?? silentLogger;
    this.#store = new ConversationStore(options.database);
    this.#transcripts = new SessionStore(options.database, { logger: this.#logger });

    const ids = new Set<string>();
    for (const grant of options.brokers) {
      if (ids.has(grant.brokerId)) {
        throw new Error(`Broker "${grant.brokerId}" is configured more than once.`);
      }
      ids.add(grant.brokerId);
      this.#grants.set(grant.brokerId, grant);
    }
  }

  public get brokerIds(): readonly string[] {
    return Object.freeze([...this.#activeBrokers].sort((a, b) => a.localeCompare(b)));
  }

  /** Every command this Nox offers, in the shape a transport renders. */
  public get commands(): readonly BrokerCommandSpec[] {
    return this.#commands.specs;
  }

  public get state(): 'created' | 'running' | 'stopped' {
    return this.#state;
  }

  /**
   * Starts every transport, and survives the ones that cannot start. A transport
   * is not the gateway: one broker with a bad credential taking every other
   * channel down with it is worse than a Nox that reports one route as failed
   * and keeps carrying the rest. The failure is recorded against the broker that
   * caused it, which is where an operator goes looking.
   */
  public async start(): Promise<void> {
    if (this.#state !== 'created') {
      throw new Error(`The gateway cannot start while it is ${this.#state}.`);
    }
    this.#state = 'running';

    for (const grant of this.#grants.values()) {
      try {
        await this.#startBroker(grant);
        this.#activeBrokers.add(grant.brokerId);
        this.#brokerStatus?.(grant.brokerId, 'active');
      } catch (error) {
        const problem = error instanceof Error ? error.message : String(error);
        this.#brokerStatus?.(grant.brokerId, 'failed', problem);
        this.#logger.error(
          { brokerId: grant.brokerId, err: error },
          'Broker failed to start; other transports remain available.',
        );
      }
    }
  }

  /**
   * Publishes a broker generation after conversations on the previous one finish
   * their current turn. If the candidate cannot start, the previous generation
   * is restarted and remains the active route.
   */
  public async replaceBroker(grant: BrokerGrant): Promise<void> {
    if (this.#state !== 'running') {
      throw new Error(`The gateway cannot replace a broker while it is ${this.#state}.`);
    }

    const previous = this.#grants.get(grant.brokerId);
    if (previous !== undefined) {
      this.#activeBrokers.delete(grant.brokerId);
      await this.retireBrokerSessions(grant.brokerId);
      try {
        await previous.broker.stop();
      } catch (error) {
        this.#activeBrokers.add(previous.brokerId);
        throw error;
      }
    }

    try {
      await this.#startBroker(grant);
      this.#grants.set(grant.brokerId, grant);
      this.#activeBrokers.add(grant.brokerId);
      this.#brokerStatus?.(grant.brokerId, 'active');
    } catch (error) {
      await grant.broker.stop().catch((stopError: unknown) => {
        this.#logger.error(
          { brokerId: grant.brokerId, err: stopError },
          'Failed broker candidate did not stop cleanly.',
        );
      });
      const problem = error instanceof Error ? error.message : String(error);
      this.#brokerStatus?.(grant.brokerId, 'failed', problem);
      if (previous !== undefined) {
        try {
          await this.#startBroker(previous);
          this.#grants.set(previous.brokerId, previous);
          this.#activeBrokers.add(previous.brokerId);
          this.#brokerStatus?.(previous.brokerId, 'active');
        } catch (rollbackError) {
          this.#logger.error(
            { brokerId: previous.brokerId, err: rollbackError },
            'The previous broker generation could not be restored.',
          );
        }
      }
      throw error;
    }
  }

  /** Stops and removes a broker after its current conversation turns settle. */
  public async removeBroker(brokerId: string): Promise<boolean> {
    const grant = this.#grants.get(brokerId);
    if (grant === undefined) return false;

    this.#activeBrokers.delete(brokerId);
    await this.retireBrokerSessions(brokerId);
    try {
      await grant.broker.stop();
    } catch (error) {
      // The last published generation stays the route when the transport could not
      // confirm the stop; new messages may reopen the sessions retired above.
      this.#activeBrokers.add(brokerId);
      throw error;
    }
    this.#grants.delete(brokerId);
    return true;
  }

  /**
   * Silences every transport. Sessions are not closed here — the application
   * owns them, and closing them is what it does next; a broker that stopped
   * first simply has nothing left to deliver to.
   */
  public async stop(): Promise<void> {
    if (this.#state === 'stopped') return;
    this.#state = 'stopped';
    this.#scheduledAbort.abort(new Error('The gateway stopped.'));

    for (const grant of [...this.#grants.values()].reverse()) {
      try {
        await grant.broker.stop();
      } catch (error) {
        this.#logger.error({ brokerId: grant.brokerId, err: error }, 'Broker failed to stop.');
      }
    }
    await Promise.allSettled([...this.#scheduledWork]);

    this.#activeBrokers.clear();
    this.#conversations.clear();
    this.#pending.clear();
  }

  /** Starts one broker with callbacks bound to exactly that immutable grant. */
  async #startBroker(grant: BrokerGrant): Promise<void> {
    await grant.broker.start({
      agentIds: () => this.#application.agentIds,
      artifactScope: (conversationId: string): ArtifactScope =>
        artifactConversationScope(grant.brokerId, conversationId),
      command: (invocation: CommandInvocation): CommandRejection | undefined =>
        this.#command(grant, invocation),
      commands: this.#commands.specs,
      ...(grant.agentId === undefined ? {} : { defaultAgentId: grant.agentId }),
      history: (
        conversationId: string,
        options?: BrokerHistoryOptions,
      ): Promise<BrokerHistory | undefined> => this.#history(grant, conversationId, options),
      logger: this.#logger.child(grant.brokerId),
      receive: (event: InboundEvent): InboundRejection | undefined => this.#receive(grant, event),
      sessions: (): Promise<readonly BrokerSession[]> => this.#sessions(grant),
      signal: this.#application.signal,
    });
  }

  /** Retires live sessions carried by one broker after their current turns. */
  public async retireBrokerSessions(brokerId: string): Promise<void> {
    const retirements = [...this.#conversations.entries()]
      .filter(([, conversation]) => conversation.key.brokerId === brokerId)
      .map(([mapKey, conversation]) => this.#retireConversation(mapKey, conversation));
    await Promise.all(retirements);
  }

  /** Retires live sessions carried by one agent after their current turns settle. */
  public async retireAgentSessions(agentId: string): Promise<void> {
    const retirements = [...this.#conversations.entries()]
      .filter(([, conversation]) => conversation.session.agentId === agentId)
      .map(([mapKey, conversation]) => this.#retireConversation(mapKey, conversation));
    await Promise.all(retirements);
  }

  #retireConversation(mapKey: string, conversation: Conversation): Promise<void> {
    return this.#queue(mapKey, async () => {
      await conversation.session.idle;
      if (this.#conversations.get(mapKey) !== conversation) return;
      this.#conversations.delete(mapKey);
      for (const [requestId, pending] of this.#pending) {
        if (pending.conversation === conversation) this.#pending.delete(requestId);
      }
      await this.#application.closeSession(conversation.session.sessionId);
    });
  }

  /** Resolves once everything queued for every conversation has settled. */
  public async drain(): Promise<void> {
    while (this.#work.size > 0) {
      await Promise.all([...this.#work.values()]);
    }
  }

  public agentIds(signal: AbortSignal): Promise<readonly string[]> {
    signal.throwIfAborted();
    if (this.#state !== 'running') {
      return Promise.reject(new Error('The runtime is not available for scheduled work.'));
    }
    return Promise.resolve(this.#application.agentIds);
  }

  public deliveryBrokerIds(signal: AbortSignal): Promise<readonly string[]> {
    signal.throwIfAborted();
    if (this.#state !== 'running') {
      return Promise.reject(new Error('The runtime is not available for scheduled work.'));
    }
    return Promise.resolve(this.brokerIds);
  }

  /** Asks the transport itself whether it would take a delivery addressed here. */
  public async canDeliverTo(
    delivery: ScheduledRunDelivery,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    if (this.#state !== 'running') {
      throw new Error('The runtime is not available for scheduled work.');
    }
    const grant = this.#grants.get(delivery.brokerId);
    if (grant === undefined || !this.#activeBrokers.has(grant.brokerId)) return false;
    // An unanswered address is an accepted one: a transport with no way to ask
    // must not become one nothing can be scheduled on.
    if (grant.broker.canDeliverTo === undefined) return true;
    return grant.broker.canDeliverTo(delivery.channelId, signal);
  }

  /**
   * The channel a live session is being spoken to on.
   *
   * Read from the live conversations rather than from the session store,
   * because the question is where a reply would go *now*: a conversation whose
   * binding was retired is no longer somewhere this gateway delivers, and
   * answering with its old channel would hand a caller an address that only
   * looks current.
   */
  public deliveryOrigin(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<ScheduledRunDelivery | undefined> {
    signal.throwIfAborted();
    for (const conversation of this.#conversations.values()) {
      if (conversation.session.sessionId !== sessionId) continue;
      return Promise.resolve({
        brokerId: conversation.key.brokerId,
        channelId: conversation.key.conversationId,
      });
    }
    return Promise.resolve(undefined);
  }

  /** Runs one occurrence in a new session and optionally posts its final response to a channel. */
  public runScheduledAgent(request: ScheduledRunRequest): Promise<ScheduledRunResult> {
    request.signal.throwIfAborted();
    if (this.#state !== 'running') {
      return Promise.reject(new Error('The runtime is not available for scheduled work.'));
    }

    const execution = this.#executeScheduledAgent(request);
    this.#scheduledWork.add(execution);
    void execution.then(
      () => {
        this.#scheduledWork.delete(execution);
      },
      () => {
        this.#scheduledWork.delete(execution);
      },
    );
    return execution;
  }

  async #executeScheduledAgent(request: ScheduledRunRequest): Promise<ScheduledRunResult> {
    const session = await this.#application.openSession(request.agentId, {
      metadata: { cronRunId: request.causeId, trigger: 'cron' },
      sessionId: request.sessionId,
      title: request.name,
    });
    const abort = (): void => {
      void session.abort();
    };
    request.signal.addEventListener('abort', abort, { once: true });
    this.#application.signal.addEventListener('abort', abort, { once: true });
    this.#scheduledAbort.signal.addEventListener('abort', abort, { once: true });

    try {
      request.signal.throwIfAborted();
      this.#application.signal.throwIfAborted();
      this.#scheduledAbort.signal.throwIfAborted();
      session.schedule(request.prompt, request.causeId);
      const completed = await scheduledCompletion(session.events);
      await session.idle;
      const content =
        session
          .getTranscript()
          .filter((message) => message.role === 'assistant')
          .at(-1)?.content ?? [];

      let deliveredAt: Date | undefined;
      let deliveryError: string | undefined;
      if (request.delivery !== undefined) {
        const candidate = this.#grants.get(request.delivery.brokerId);
        const grant =
          candidate !== undefined && this.#activeBrokers.has(candidate.brokerId)
            ? candidate
            : undefined;
        if (!hasUsableContent(content)) {
          deliveryError = 'The scheduled agent produced no response to deliver.';
        } else if (grant === undefined) {
          deliveryError = `Scheduled delivery names unknown broker "${request.delivery.brokerId}".`;
        } else if (this.#state !== 'running' || this.#application.signal.aborted) {
          deliveryError = 'The runtime stopped before the scheduled response could be delivered.';
        } else {
          try {
            await grant.broker.deliver({
              content,
              conversationId: request.delivery.channelId,
              text: textOf(content),
              turnId: completed.runId,
              type: 'message',
            });
            deliveredAt = new Date();
          } catch (error) {
            deliveryError = error instanceof Error ? error.message : String(error);
          }
        }
      }

      return {
        completedAt: completed.completedAt,
        content,
        ...(deliveredAt === undefined ? {} : { deliveredAt }),
        ...(deliveryError === undefined ? {} : { deliveryError }),
        ...(completed.error === undefined ? {} : { error: completed.error }),
        runId: completed.runId,
        sessionId: session.sessionId,
        startedAt: completed.startedAt,
        status: completed.status,
      };
    } finally {
      request.signal.removeEventListener('abort', abort);
      this.#application.signal.removeEventListener('abort', abort);
      this.#scheduledAbort.signal.removeEventListener('abort', abort);
      await this.#application.closeSession(session.sessionId);
    }
  }

  /**
   * What a broker calls. It returns immediately and never throws: a transport
   * handing over what arrived is not where a session's failure is handled.
   */
  #receive(grant: BrokerGrant, event: InboundEvent): InboundRejection | undefined {
    if (
      this.#state !== 'running' ||
      !this.#activeBrokers.has(grant.brokerId) ||
      this.#grants.get(grant.brokerId) !== grant
    ) {
      return { reason: 'unavailable' };
    }

    if (event.type === 'message' || event.type === 'steer') {
      const requested = event.requestedAgentId;
      if (requested !== undefined) {
        if (grant.selectableAgent !== true || !this.#application.agentIds.includes(requested)) {
          return { agentId: requested, reason: 'unknownAgent' };
        }
      } else if (this.#bindingFor(grant, event.conversationId).agentId === undefined) {
        return { agents: this.#application.agentIds, reason: 'agentRequired' };
      }
    }

    // Permission is an answer to work already waiting. Queueing it behind that
    // work would deadlock a command whose Gate is waiting for this exact answer.
    if (event.type === 'permission') {
      this.#handlePermission(grant, event);
      return undefined;
    }

    void this.#queue(keyOf(grant.brokerId, event.conversationId), async () => {
      switch (event.type) {
        case 'message':
        case 'observation':
        case 'steer':
          await this.#handleSpeech(grant, event);
          break;
      }
    });
    return undefined;
  }

  /** Chains work per conversation, so nothing about one chat runs twice at once. */
  #queue(key: string, task: () => Promise<void>): Promise<void> {
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
    return next;
  }

  /**
   * Something said into a conversation, and the two ways of saying it. A steer
   * explicitly marks new direction for the run in flight but queues like any
   * other speech and never cancels; both are attributed, deduplicated and
   * serialized exactly the same way.
   */
  async #handleSpeech(
    grant: BrokerGrant,
    message: InboundMessage | InboundObservation | InboundSteer,
  ): Promise<void> {
    const { content } = message;
    if (!hasUsableContent(content)) return;

    const binding = this.#bindingFor(grant, message.conversationId);
    const conversation = await this.#attach(
      grant,
      binding,
      message.conversationId,
      message.requestedAgentId,
    );

    // A transport that retries a delivery must not produce a second turn. This
    // is remembered per live conversation, not stored: a duplicate arriving
    // after a restart is indistinguishable from a real message.
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
      ...(message.senderName === undefined ? {} : { displayName: message.senderName }),
      principal: { issuer: grant.brokerId, subject: message.senderId },
      transportMessageId: message.messageId,
    };

    // An observation is not a turn and does not make the conversation newer:
    // the agent was not spoken to.
    if (message.type === 'observation') {
      conversation.session.observe(content, origin, message.receivedAt);
      return;
    }

    if (message.type === 'steer') {
      await conversation.session.steer(content, origin, message.receivedAt);
    } else {
      conversation.session.send(content, origin, message.receivedAt);
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
    if (
      this.#state !== 'running' ||
      !this.#activeBrokers.has(grant.brokerId) ||
      this.#grants.get(grant.brokerId) !== grant
    ) {
      return { reason: 'unavailable' };
    }

    const checked = this.#commands.check(invocation);
    if ('rejection' in checked) return checked.rejection;

    void this.#queue(keyOf(grant.brokerId, invocation.conversationId), () =>
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

    const commandId = `command_${nanoid()}`;
    let current = conversation;
    const info = () => ({
      agentId: current.session.agentId,
      contextUsage: current.session.getContextUsage(),
      modelId: current.session.modelId,
      sessionId: current.session.sessionId,
      ...(current.session.title === undefined ? {} : { title: current.session.title }),
      tools: current.session.getToolNames(),
    });
    const context: CommandContext = {
      abort: () => current.session.abort(),
      close: async (): Promise<void> => {
        this.#conversations.delete(mapKey);
        // Closing resolves whatever the Gate was still holding, and those
        // outcomes are delivered on the way down; only then is there nothing
        // left to retract.
        await this.#application.closeSession(current.session.sessionId);
        for (const [requestId, pending] of this.#pending) {
          if (pending.conversation === current) this.#pending.delete(requestId);
        }
      },
      compact: () => current.session.compact(),
      conversationId: invocation.conversationId,
      info,
      listAgents: () =>
        grant.selectableAgent === true
          ? this.#application.agentIds
          : Object.freeze([current.session.agentId]),
      listCommands: () =>
        this.#commands.specs.map(({ description, name }) => ({ description, name })),
      listModels: () => {
        const agent = this.#application.getAgent(current.session.agentId);
        return (agent?.modelIds ?? []).map((modelId) => ({
          current: modelId === current.session.modelId,
          modelId,
        }));
      },
      newSession: async () => {
        current = await this.#replaceCommandSession(current, {
          agentId: current.session.agentId,
          modelId: current.session.modelId,
        });
        return info();
      },
      rename: (title) => current.session.rename(title),
      retry: () =>
        current.session.retry({ issuer: grant.brokerId, subject: invocation.senderId }, commandId),
      sender: { issuer: grant.brokerId, subject: invocation.senderId },
      switchAgent: async (agentId) => {
        if (grant.selectableAgent !== true && agentId !== current.session.agentId) {
          throw new Error(
            `Broker "${grant.brokerId}" does not allow conversations to select another agent.`,
          );
        }
        current = await this.#replaceCommandSession(current, { agentId });
        return info();
      },
      switchModel: async (modelId) => {
        current = await this.#replaceCommandSession(current, {
          agentId: current.session.agentId,
          modelId,
          preserveHistory: true,
        });
        return info();
      },
    };

    let status: 'completed' | 'failed' = 'completed';
    let text = `/${command.name} completed.`;
    try {
      if (command.authority !== undefined) {
        const authorization = await current.session.authorizeCommand({
          authority: command.authority,
          commandId,
          name: command.name,
          params: args,
          principal: context.sender,
          risk: command.risk?.(args) ?? { effects: [] },
        });
        if (!authorization.allowed) throw new Error(authorization.reason);
      }
      const result = await command.run(context, args);
      if (result !== undefined) text = result.text;
    } catch (error) {
      status = 'failed';
      text = error instanceof Error ? error.message : String(error);
      this.#logger.warn(
        { brokerId: grant.brokerId, command: command.name, err: error },
        'Command failed.',
      );
    }

    if (shows(grant.broker, 'commands')) {
      this.#deliver(
        current,
        { name: command.name, status, text, type: 'commandResult' },
        commandId,
      );
    }
  }

  /** Replaces only the session behind one transport conversation. */
  async #replaceCommandSession(
    conversation: Conversation,
    selection: {
      readonly agentId: string;
      readonly modelId?: string;
      readonly preserveHistory?: boolean;
    },
  ): Promise<Conversation> {
    const agent = this.#application.getAgent(selection.agentId);
    if (agent === undefined) throw new Error(`Agent "${selection.agentId}" is not available.`);
    if (selection.modelId !== undefined && !agent.modelIds.includes(selection.modelId)) {
      throw new Error(
        `Model "${selection.modelId}" is not available to agent "${selection.agentId}".`,
      );
    }

    await conversation.session.idle;
    const previousAgentId = conversation.session.agentId;
    const previousModelId = conversation.session.modelId;
    const previousSessionId = conversation.session.sessionId;
    const persisted = await this.#store.find(conversation.key);
    if (persisted === undefined) {
      throw new Error('The open conversation has no durable binding to replace.');
    }

    const preserveHistory = selection.preserveHistory === true;
    if (preserveHistory && selection.agentId !== previousAgentId) {
      throw new Error('A transcript cannot be resumed as a different agent.');
    }

    const mapKey = keyOf(conversation.key.brokerId, conversation.key.conversationId);
    const binding = this.#bindingFor(conversation.grant, conversation.key.conversationId);
    const open = (
      agentId: string,
      modelId: string | undefined,
      sessionId: string | undefined,
      parentSessionId?: string,
    ): Promise<Session> =>
      this.#application.openSession(agentId, {
        artifactScope: artifactConversationScope(
          conversation.key.brokerId,
          conversation.key.conversationId,
        ),
        authorization: binding.authorization,
        metadata: {
          brokerId: conversation.key.brokerId,
          conversationId: conversation.key.conversationId,
          ...(parentSessionId === undefined ? {} : { parentSessionId }),
        },
        modelId,
        sessionId,
      });
    const activate = (session: Session): Conversation => {
      const replacement: Conversation = {
        grant: conversation.grant,
        key: conversation.key,
        seen: conversation.seen,
        seenIds: conversation.seenIds,
        session,
        turnId: nanoid(),
      };
      this.#conversations.set(mapKey, replacement);
      void this.#watch(replacement);
      return replacement;
    };

    await this.#application.closeSession(previousSessionId);
    let opened: Session | undefined;
    try {
      opened = await open(
        selection.agentId,
        selection.modelId,
        preserveHistory ? previousSessionId : undefined,
        preserveHistory ? undefined : previousSessionId,
      );
      if (preserveHistory) {
        await this.#store.setModel(conversation.key, selection.modelId);
      } else {
        await this.#store.rebind(
          conversation.key,
          selection.agentId,
          opened.sessionId,
          selection.modelId,
        );
      }
      return activate(opened);
    } catch (error) {
      if (opened !== undefined) await this.#application.closeSession(opened.sessionId);
      try {
        const restored = await open(previousAgentId, previousModelId, previousSessionId);
        await this.#store.rebind(
          conversation.key,
          persisted.agentId,
          persisted.sessionId,
          persisted.modelId ?? undefined,
        );
        activate(restored);
      } catch (restoreError) {
        this.#conversations.delete(mapKey);
        this.#logger.error(
          { err: restoreError, sessionId: previousSessionId },
          'Could not restore a conversation after its command transition failed.',
        );
      }
      throw error;
    }
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
          // Read from the row rather than from the live session: a closed
          // conversation has nothing to ask, and it is just as named.
          title: row.title ?? undefined,
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
    requestedAgentId?: string,
  ): Promise<Conversation> {
    const mapKey = keyOf(grant.brokerId, conversationId);
    const live = this.#conversations.get(mapKey);
    // A session stopped from another surface leaves the binding intact; the next
    // message reopens it rather than starting the conversation over.
    if (live !== undefined && live.session.state !== 'stopped') return live;
    this.#conversations.delete(mapKey);

    const key: ConversationKey = { brokerId: grant.brokerId, conversationId };
    const bound = await this.#store.find(key);
    // A route chooses an agent only when the conversation is first bound. Changing
    // the broker default must not move existing transcripts to another agent.
    const agentId = bound?.agentId ?? requestedAgentId ?? binding.agentId;
    if (agentId === undefined) {
      throw new Error(`Broker "${grant.brokerId}" did not select an agent for this conversation.`);
    }
    const session = await this.#application.openSession(agentId, {
      artifactScope: artifactConversationScope(grant.brokerId, conversationId),
      authorization: binding.authorization,
      metadata: { brokerId: grant.brokerId, conversationId },
      modelId: bound?.modelId ?? undefined,
      sessionId: bound?.sessionId,
    });

    if (bound === undefined) await this.#store.bind(key, agentId, session.sessionId);

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
   * Turns one session's events into what its transport can show. Every event a
   * run produces is offered here; what leaves is what the broker declared it
   * renders. That split is the point — whether reasoning, tool activity or
   * token counts belong on a surface is a question about the surface, not one
   * the gateway should answer for transports it has never seen.
   *
   * Two things stay behind, and neither is about rendering: what another
   * participant said, and which principal used which authority, are questions
   * about who may see what.
   */
  async #watch(conversation: Conversation): Promise<void> {
    const { broker } = conversation.grant;
    // Whether anyone may answer is no longer the transport's question: the one
    // person who can is the principal whose run raised the request, and they are
    // in this conversation by definition. Only whether the transport can put the
    // question in front of them at all remains.
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
        case 'titled':
          if (shows(broker, 'titles')) {
            this.#deliver(conversation, { title: event.title, type: 'title' });
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
