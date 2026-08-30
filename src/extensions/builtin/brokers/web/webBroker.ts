import {
  type Broker,
  type BrokerCapabilities,
  type BrokerHistory,
  type BrokerHistoryEntry,
  type BrokerHost,
  type BrokerSession,
  type ChatCommand,
  type ChatCommandInput,
  type ChatCommandRejection,
  type ChatConversation,
  type ChatDecisionInput,
  type ChatEvent,
  type ChatHistory,
  type ChatHistoryEntry,
  type ChatHistoryInput,
  type ChatListener,
  type ChatMessageInput,
  type ChatMessageRejection,
  type ChatPermissionOutcome,
  type ChatPermissionRequest,
  type ChatSubscriptionOptions,
  type ChatSurfaceHub,
  type ChatTransport,
  type OutboundEvent,
  type PermissionRequest,
  type PermissionResolution,
  WEB_BROKER_ID,
} from '@nox/extension-api';
import { nanoid } from 'nanoid';

/** Enough completed traffic to repair an ordinary dropped browser connection. */
const RECENT_EVENT_LIMIT = 10_000;

interface SequencedChatEvent {
  readonly event: ChatEvent;
  readonly eventId: number;
}

/**
 * Nox's own web surface, as a broker — the first transport that does not dial
 * out: connections are handed to it by the browser, and its ingress rule is the
 * access token the route already checked. That changes nothing about what a
 * broker is: it delivers what arrived and renders what it is handed, and knows
 * nothing about agents, sessions or the transcript.
 *
 * Both capabilities are declared because both are real here: the stream can
 * show a reply while it is being written, and a person is on the other end —
 * exactly what the gateway is asking when it decides whether to send a
 * permission request at all.
 */
class WebBroker implements Broker, ChatTransport {
  /**
   * It takes everything, and that is the difference between this transport and a
   * bot in a channel: a chat service can post text, while this surface gives a
   * tool call, a compaction or a run cut at `maxIterations` somewhere to go. A
   * client still decides what it draws, but nothing is decided for it upstream.
   */
  public readonly capabilities: BrokerCapabilities = Object.freeze({
    commands: true,
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

  readonly #activeEvents = new Map<string, SequencedChatEvent[]>();
  readonly #hub: ChatSurfaceHub;
  readonly #listeners = new Set<ChatListener>();
  readonly #recentEvents: SequencedChatEvent[] = [];

  #detach: (() => void) | undefined;
  #host: BrokerHost | undefined;
  #nextEventId = 0;

  constructor(hub: ChatSurfaceHub) {
    this.#hub = hub;
  }

  /**
   * Whether this surface carries the conversation named.
   *
   * Answered because on this transport an address is not a room someone can be
   * pointed at: a browser mints a conversation ID per chat, so a scheduled
   * delivery aimed at one that was never bound — a typo, or a chat abandoned
   * before anyone spoke in it — names nothing and will keep naming nothing.
   * Without this the host's fallback treats every string as an acceptable
   * address, and the wrong one is only discovered by a run that reports
   * delivering to it.
   *
   * Unclaimed is thrown rather than returned false: a surface that has not been
   * started yet cannot tell a live conversation from an invented one, and false
   * is reserved for an answer that will not change.
   */
  public async canDeliverTo(channelId: string): Promise<boolean> {
    const host = this.#host;
    if (host === undefined) throw new Error('The web surface is not available.');

    const sessions = await host.sessions();
    return sessions.some((session) => session.conversationId === channelId);
  }

  /**
   * A new conversation for an unattended run's reply.
   *
   * A channel here is a conversation and nothing more, so there is no room to
   * post into: appending a cron run's answer to the chat that scheduled it
   * would drop it into a transcript a person is still using, attributed to a
   * prompt that was never typed there. It arrives as its own conversation
   * instead, which is also what makes it survive — a bound conversation has a
   * transcript, while a loose event only exists for whoever happened to be
   * watching.
   *
   * Shaped like the IDs the client mints for the same reason it uses that shape
   * itself: this is one more web conversation, and nothing downstream should be
   * able to tell which side named it.
   */
  public openScheduledConversation(): string {
    return `${WEB_BROKER_ID}_${nanoid(24)}`;
  }

  /** Claims the surface. Until this runs the chat routes answer that they are unavailable. */
  public start(host: BrokerHost): Promise<void> {
    this.#host = host;
    this.#detach = this.#hub.attach(this);
    return Promise.resolve();
  }

  /**
   * Lets go of the surface. The routes go back to answering `chat_unavailable`
   * immediately; streams already open end when the HTTP server they belong to
   * stops, which is the next thing a shutdown does.
   */
  public stop(): Promise<void> {
    this.#detach?.();
    this.#detach = undefined;
    this.#activeEvents.clear();
    this.#listeners.clear();
    this.#recentEvents.length = 0;
    this.#host = undefined;
    return Promise.resolve();
  }

  /**
   * Renders one event to everyone watching and keeps a bounded reconnect log.
   * The current run is retained separately until it completes, so a newly loaded
   * page can reconstruct text that has not reached the durable transcript yet.
   *
   * An event that carries the reply itself is then checked against the
   * conversations this surface actually carries, and reports failure when it
   * names none. Not the same question as whether a browser was watching: a
   * connected stream is not what makes a reply survive here — the conversation
   * behind it is, and a reply addressed to a conversation that was never bound
   * has nowhere to be read back from, now or later. Left unreported it would be
   * recorded as delivered by the one caller with nobody there to notice.
   *
   * The check runs after the render rather than before it so that nothing in
   * this method awaits ahead of the listeners: callers hand events over without
   * waiting, and a delivery that paused mid-run would let the fragments behind
   * it overtake the message they belong to.
   */
  public async deliver(event: OutboundEvent): Promise<void> {
    const rendered = toChatEvent(event);
    const sequenced = { event: rendered, eventId: ++this.#nextEventId };
    this.#retainRecent(sequenced);
    this.#retainActive(sequenced);

    if (this.#listeners.size === 0) {
      this.#host?.logger.debug(
        { conversationId: event.conversationId, event: event.type },
        'Buffered an event while no chat stream was connected.',
      );
    }

    // A copy, because a listener that fails is removed while this iterates.
    for (const listener of [...this.#listeners]) {
      try {
        listener(rendered, sequenced.eventId);
      } catch (error) {
        this.#listeners.delete(listener);
        this.#host?.logger.warn({ err: error }, 'A chat stream failed and was dropped.');
      }
    }

    if (event.type === 'runCompleted') this.#activeEvents.delete(turnKey(rendered));

    if (!carriesReply(event)) return;
    if (!(await this.canDeliverTo(event.conversationId))) {
      throw new Error(
        `The web surface carries no conversation "${event.conversationId}" to deliver to.`,
      );
    }
  }

  /**
   * The commands the gateway offers, passed through rather than curated. What a
   * client draws from them is the client's decision, exactly as it is for events:
   * this surface is a UI over the runtime, and deciding upstream which commands a
   * browser deserves would be doing its product design for it.
   */
  public listCommands(): readonly ChatCommand[] {
    return this.#host?.commands ?? [];
  }

  /** The current choices for a new browser conversation. */
  public listAgents(): { readonly agents: readonly string[]; readonly defaultAgent?: string } {
    const host = this.#host;
    if (host === undefined) return { agents: [] };
    return {
      agents: host.agentIds(),
      ...(host.defaultAgentId === undefined ? {} : { defaultAgent: host.defaultAgentId }),
    };
  }

  /**
   * Every conversation this surface carries. Answered from the gateway rather
   * than from anything kept here: a transport that remembered its own list would
   * come up after a restart believing it carries nothing.
   */
  public listConversations(): Promise<readonly ChatConversation[]> {
    const host = this.#host;
    if (host === undefined) return Promise.resolve([]);

    return host.sessions().then((sessions) => sessions.map(toChatConversation));
  }

  /** One conversation read back, as much of it as this surface may show. */
  public readHistory(input: ChatHistoryInput): Promise<ChatHistory | undefined> {
    const host = this.#host;
    if (host === undefined) return Promise.resolve(undefined);

    return host
      .history(input.conversationId, input.limit === undefined ? undefined : { limit: input.limit })
      .then((history) => (history === undefined ? undefined : toChatHistory(history)));
  }

  /**
   * Invokes a command. A route and not a prefix on a message: "/stop" typed into
   * a chat is a word the model reads, and nothing a person says in prose acts on
   * a conversation. A client that wants a slash command builds one out of the
   * catalog and posts it here — what a surface does with what someone types is
   * the surface's business, never the runtime's.
   */
  public submitCommand(input: ChatCommandInput): ChatCommandRejection | undefined {
    // Explicitly, because nothing is the answer for an accepted invocation:
    // coalescing it would report every accepted command as a refused one.
    const host = this.#host;
    if (host === undefined) return { reason: 'unavailable' };

    return host.command({
      arguments: input.arguments,
      command: input.command,
      conversationId: input.conversationId,
      senderId: input.senderId,
    });
  }

  public submitDecision(input: ChatDecisionInput): void {
    // Approving "once" when no scope was named: the narrower reading of an
    // ambiguous answer is the only safe one.
    const resolution =
      input.decision === 'approve' ? ({ approved: input.scope ?? 'once' } as const) : 'denied';

    this.#host?.receive({
      conversationId: input.conversationId,
      requestId: input.requestId,
      resolution,
      senderId: input.senderId,
      type: 'permission',
    });
  }

  public submitMessage(input: ChatMessageInput): ChatMessageRejection | undefined {
    const host = this.#host;
    if (host === undefined) return { reason: 'unavailable' };
    return host.receive({
      ...(input.agentId === undefined ? {} : { requestedAgentId: input.agentId }),
      content: input.content,
      conversationId: input.conversationId,
      messageId: input.messageId,
      receivedAt: new Date(),
      senderId: input.senderId,
      type: 'message',
    });
  }

  /**
   * Adds direction at the next safe opening in the run in flight. Speech, not a
   * command: it is attributed, deduplicated and appended to the transcript like
   * anything else someone said, and its UI is the message box rather than a
   * palette.
   */
  public submitSteer(input: ChatMessageInput): ChatMessageRejection | undefined {
    const host = this.#host;
    if (host === undefined) return { reason: 'unavailable' };
    return host.receive({
      ...(input.agentId === undefined ? {} : { requestedAgentId: input.agentId }),
      content: input.content,
      conversationId: input.conversationId,
      messageId: input.messageId,
      receivedAt: new Date(),
      senderId: input.senderId,
      type: 'steer',
    });
  }

  public subscribe(listener: ChatListener, options?: ChatSubscriptionOptions): () => void {
    this.#listeners.add(listener);

    const afterEventId = options?.afterEventId;
    const replay =
      afterEventId === undefined
        ? [...this.#activeEvents.values()].flat().sort((a, b) => a.eventId - b.eventId)
        : this.#recentEvents.filter((entry) => entry.eventId > afterEventId);
    for (const entry of replay) listener(entry.event, entry.eventId);

    return (): void => {
      this.#listeners.delete(listener);
    };
  }

  #retainActive(entry: SequencedChatEvent): void {
    const key = turnKey(entry.event);
    if (entry.event.type === 'runStarted') {
      this.#activeEvents.set(key, [entry]);
      return;
    }

    this.#activeEvents.get(key)?.push(entry);
  }

  #retainRecent(entry: SequencedChatEvent): void {
    this.#recentEvents.push(entry);
    const overflow = this.#recentEvents.length - RECENT_EVENT_LIMIT;
    if (overflow > 0) this.#recentEvents.splice(0, overflow);
  }
}

/**
 * Whether losing this event loses the reply. The three that say something on
 * their own; everything else decorates a run that carries its own answer, and
 * is best-effort by contract.
 */
function carriesReply(event: OutboundEvent): boolean {
  return event.type === 'commandResult' || event.type === 'error' || event.type === 'message';
}

function turnKey(event: ChatEvent): string {
  return `${event.conversationId}\u0000${event.turnId}`;
}

/** The runtime's event as the wire says it. */
function toChatEvent(event: OutboundEvent): ChatEvent {
  const base = { conversationId: event.conversationId, turnId: event.turnId };

  switch (event.type) {
    case 'commandResult':
      return {
        ...base,
        name: event.name,
        status: event.status,
        text: event.text,
        type: 'commandResult',
      };
    case 'error':
    case 'fragment':
    case 'reasoning':
    case 'reasoningFragment':
      return { ...base, text: event.text, type: event.type };
    case 'message':
      return { ...base, content: event.content, text: event.text, type: 'message' };
    case 'contextChange':
      return {
        ...base,
        change: event.change,
        replacedMessageIds: event.replacedMessageIds,
        text: event.text,
        type: 'contextChange',
      };
    case 'contextUsage':
      return { ...base, type: 'contextUsage', usage: event.usage };
    case 'permission':
      return { ...base, request: toPermissionRequest(event.request), type: 'permission' };
    case 'permissionResolved':
      return {
        ...base,
        outcome: toOutcome(event.resolution),
        requestId: event.requestId,
        type: 'permissionResolved',
      };
    case 'retry':
      return {
        ...base,
        attempt: event.attempt,
        delayMs: event.delayMs,
        text: event.text,
        type: 'retry',
      };
    case 'runCompleted':
      return {
        ...base,
        durationMs: event.durationMs,
        status: event.status,
        type: 'runCompleted',
        usage: event.usage,
      };
    case 'runStarted':
      return {
        ...base,
        modelId: event.modelId,
        startedAt: event.startedAt.toISOString(),
        trigger: event.trigger,
        type: 'runStarted',
      };
    case 'title':
      return { ...base, title: event.title, type: 'title' };
    case 'toolCall':
      return {
        ...base,
        arguments: event.arguments,
        name: event.name,
        trackId: event.trackId,
        type: 'toolCall',
      };
    case 'toolResponse':
      return {
        ...base,
        content: event.content,
        execution: event.execution,
        isError: event.isError,
        name: event.name,
        text: event.text,
        trackId: event.trackId,
        type: 'toolResponse',
      };
    case 'usage':
      return { ...base, type: 'usage', usage: event.usage };
  }
}

/** A conversation read back, as the wire says it. */
function toChatHistory(history: BrokerHistory): ChatHistory {
  return {
    agentId: history.agentId,
    contextUsage: history.contextUsage,
    conversationId: history.conversationId,
    entries: history.entries.map(toChatHistoryEntry),
    sessionId: history.sessionId,
  };
}

/**
 * One transcript entry on the wire. Same vocabulary as the stream, so a client
 * draws a conversation it scrolled back to with the code that draws one
 * arriving; all that changes is where it sits — a message in a conversation
 * rather than a fragment of a run.
 */
function toChatHistoryEntry(entry: BrokerHistoryEntry): ChatHistoryEntry {
  const base = { at: entry.at.toISOString(), messageId: entry.messageId };

  switch (entry.type) {
    case 'contextChange':
      return {
        ...base,
        change: entry.change,
        replacedMessageIds: entry.replacedMessageIds,
        text: entry.text,
        type: 'contextChange',
      };
    case 'reasoning':
      return { ...base, text: entry.text, type: entry.type };
    case 'message':
      return { ...base, content: entry.content, text: entry.text, type: 'message' };
    case 'toolCall':
      return {
        ...base,
        arguments: entry.arguments,
        name: entry.name,
        trackId: entry.trackId,
        type: 'toolCall',
      };
    case 'toolResponse':
      return {
        ...base,
        content: entry.content,
        execution: entry.execution,
        isError: entry.isError,
        name: entry.name,
        text: entry.text,
        trackId: entry.trackId,
        type: 'toolResponse',
      };
    case 'userMessage':
      return {
        ...base,
        content: entry.content,
        mode: entry.mode,
        principal: entry.principal,
        text: entry.text,
        type: 'userMessage',
      };
  }
}

function toChatConversation(session: BrokerSession): ChatConversation {
  return {
    agentId: session.agentId,
    contextUsage: session.contextUsage,
    conversationId: session.conversationId,
    sessionId: session.sessionId,
    startedAt: session.startedAt.toISOString(),
    state: session.state,
    title: session.title,
    updatedAt: session.updatedAt.toISOString(),
  };
}

/**
 * What a person needs in order to answer, and nothing that only means something
 * inside Nox: `runAuthority` and `trackId` say who may approve and where the
 * call sits in a run, and both questions are already settled by the time this
 * is sent.
 */
function toPermissionRequest(request: PermissionRequest): ChatPermissionRequest {
  return {
    authority: request.authority,
    expiresAt: request.expiresAt.toISOString(),
    params: request.params,
    preview: request.preview,
    reason: request.reason,
    requestId: request.requestId,
    requestedAt: request.requestedAt.toISOString(),
    risk: request.risk,
    runId: request.runId,
    sessionId: request.sessionId,
    signals: request.signals,
    title: request.title,
    toolName: request.toolName,
    toolSetId: request.toolSetId,
  };
}

function toOutcome(resolution: PermissionResolution): ChatPermissionOutcome {
  return resolution.resolution === 'approved'
    ? { resolution: 'approved', scope: resolution.scope }
    : { resolution: resolution.resolution };
}

export { WebBroker };
