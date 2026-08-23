import type {
  ChatCommand,
  ChatCommandInput,
  ChatCommandRejection,
  ChatConversation,
  ChatDecisionInput,
  ChatEvent,
  ChatHistory,
  ChatHistoryEntry,
  ChatHistoryInput,
  ChatHub,
  ChatListener,
  ChatMessageInput,
  ChatPermissionOutcome,
  ChatPermissionRequest,
  ChatTransport,
} from '../../../../api/chat';
import type {
  Broker,
  BrokerCapabilities,
  BrokerHistory,
  BrokerHistoryEntry,
  BrokerHost,
  BrokerSession,
  OutboundEvent,
} from '../../../../gateway/broker';
import type { PermissionRequest, PermissionResolution } from '../../../../tool/gate';

/**
 * Nox's own web surface, as a broker.
 *
 * It is the first transport that does not dial out. A bot elsewhere opens a
 * connection to a chat service; this one is handed connections by the browser,
 * and its ingress rule is the access token the route already checked. That
 * changes nothing about what a broker is: it delivers what arrived and renders
 * what it is handed, and it knows nothing about agents, sessions or the
 * transcript.
 *
 * Both capabilities are declared because both are real here. The stream can
 * show a reply while it is being written, and a person is on the other end of
 * it — which is exactly what the gateway is asking when it decides whether to
 * send a permission request at all.
 */
class WebBroker implements Broker, ChatTransport {
  /**
   * It takes everything, and that is the difference between this transport and a
   * bot in a channel. A chat service can post text; this one is a surface built
   * over the runtime itself, where a tool call, a compaction or a run that ended
   * at `maxIterations` each have somewhere to go — a card, a fold, a status. A
   * client still decides what it draws, but nothing is decided for it upstream.
   */
  public readonly capabilities: BrokerCapabilities = Object.freeze({
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

  readonly #hub: ChatHub;
  readonly #listeners = new Set<ChatListener>();

  #detach: (() => void) | undefined;
  #host: BrokerHost | undefined;

  constructor(hub: ChatHub) {
    this.#hub = hub;
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
    this.#listeners.clear();
    this.#host = undefined;
    return Promise.resolve();
  }

  /**
   * Renders one event to everyone watching. Nobody watching is an ordinary
   * state — a closed tab, a person who walked away — and the event is dropped
   * rather than held: the transcript already has the reply, and this surface has
   * no memory of its own to keep it in.
   */
  public deliver(event: OutboundEvent): Promise<void> {
    if (this.#listeners.size === 0) {
      this.#host?.logger.debug(
        { conversationId: event.conversationId, event: event.type },
        'Dropped an event: nothing is watching this conversation.',
      );
      return Promise.resolve();
    }

    const rendered = toChatEvent(event);
    // A copy, because a listener that fails is removed while this iterates.
    for (const listener of [...this.#listeners]) {
      try {
        listener(rendered);
      } catch (error) {
        this.#listeners.delete(listener);
        this.#host?.logger.warn({ err: error }, 'A chat stream failed and was dropped.');
      }
    }

    return Promise.resolve();
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

  public submitMessage(input: ChatMessageInput): void {
    this.#host?.receive({
      content: input.content,
      conversationId: input.conversationId,
      messageId: input.messageId,
      receivedAt: new Date(),
      senderId: input.senderId,
      type: 'message',
    });
  }

  /**
   * Says something over the top of the run in flight. Speech, not a command: it
   * is attributed, deduplicated and appended to the transcript like anything
   * else someone said, and its UI is the message box rather than a palette.
   */
  public submitSteer(input: ChatMessageInput): void {
    this.#host?.receive({
      content: input.content,
      conversationId: input.conversationId,
      messageId: input.messageId,
      receivedAt: new Date(),
      senderId: input.senderId,
      type: 'steer',
    });
  }

  public subscribe(listener: ChatListener): () => void {
    this.#listeners.add(listener);

    return (): void => {
      this.#listeners.delete(listener);
    };
  }
}

/** The runtime's event as the wire says it. */
function toChatEvent(event: OutboundEvent): ChatEvent {
  const base = { conversationId: event.conversationId, turnId: event.turnId };

  switch (event.type) {
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
