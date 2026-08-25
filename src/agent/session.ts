import { nanoid } from 'nanoid';

import { ArtifactOutputSink } from '../artifact/output';
import { ConversationParticipants } from '../auth/conversation';
import { type DecisionRecord, SessionStore } from '../database/sessionStore';
import {
  type GateEvaluator,
  type GatePolicyInput,
  type PermissionRequest,
  type PermissionResolution,
  SessionGate,
} from '../tool/gate';
import { EventLog } from '../utils/eventLog';
import { Context } from './context/context';
import { Runner, type RunnerOptions, type RunnerState } from './runner';
import { generateTitle } from './title';

import type { ArtifactPipeline } from '../artifact/pipeline';
import type { ArtifactScope } from '../artifact/types';
import type { DecisionAuditSink } from '../auth/audit';
import type { AuthorityCatalog } from '../auth/authority';
import type { AuthorizationProvider } from '../auth/authorization';
import type { MessageOrigin, PrincipalRef } from '../auth/principal';
import type { Database } from '../database/database';
import type { Logger } from '../logger/logger';
import type { ModelConfig } from '../provider/config';
import type { ChatProvider } from '../provider/provider';
import type { Message, MessageContent, UserMessage, UserMessageDelivery } from './context/message';
import type { ContextOptions, ContextUsage } from './context/options';
import type { AgentEvent } from './events';

interface SessionOptions extends RunnerOptions {
  /** The agent holding the conversation, stored so the transcript stays attributable. */
  agentId: string;
  /** Host storage and ownership for user-facing files produced during this session. */
  artifacts?: ArtifactPipeline;
  artifactScope?: ArtifactScope;
  /** Every authority this Nox knows. Absent means nothing can be authorized. */
  authorities?: AuthorityCatalog;
  /** Held as a reference and consulted per call, never snapshotted here. */
  authorization?: AuthorizationProvider;
  /** Provider used for internal compaction requests; defaults to the main provider. */
  compactionProvider?: ChatProvider;
  /** Everything the context needs except the history, which comes from storage. */
  context?: Omit<ContextOptions, 'fullHistory' | 'onAppend'>;
  gate?: GatePolicyInput;
  gateEvaluators?: readonly GateEvaluator[];
  logger?: Logger;
  metadata?: Readonly<Record<string, unknown>>;
  /** Omit to start a new session; pass one to resume it. */
  sessionId?: string;
  systemPrompt: string;
  /**
   * A name given rather than generated. A session that arrives with one is
   * never titled by the model: naming it twice would rename it under whoever
   * chose the first one.
   */
  title?: string;
  /** Model used for the internal titling request; defaults to the main model. */
  titleModel?: ModelConfig;
  /** Provider used for internal titling requests; defaults to the main provider. */
  /** The zone timestamps are written in when a model is shown this conversation. */
  timeZone?: string;
  titleProvider?: ChatProvider;
}

type UserMessageInput = readonly MessageContent[] | string;

function toUserMessage(
  input: UserMessageInput,
  origin: MessageOrigin,
  delivery: UserMessageDelivery,
): UserMessage {
  return {
    content: typeof input === 'string' ? [{ text: input, type: 'text' }] : [...input],
    createdAt: new Date(),
    delivery,
    messageId: nanoid(),
    origin,
    role: 'user',
  };
}

/**
 * One agent's conversation: a transcript, the context derived from it, and the
 * runner that drives them.
 *
 * The session owns the one path out of the transcript. Every append — replies,
 * tool traffic, and the folds and compactions the context writes on its own —
 * reaches storage and the event log through the same sink, so neither can miss
 * a message by forgetting to subscribe somewhere.
 */
class Session {
  readonly #agentId: string;
  readonly #context: Context;
  readonly #events = new EventLog<AgentEvent>();
  readonly #gate: SessionGate;
  readonly #logger?: Logger;
  readonly #runner: Runner;
  readonly #sessionId: string;
  readonly #store: SessionStore;
  readonly #titleModel?: ModelConfig;
  readonly #titleProvider: ChatProvider;
  /** Aborts the titling request when the session ends before it has answered. */
  readonly #titling = new AbortController();

  #title?: string;
  #titledOnce?: Promise<void>;

  private constructor(
    sessionId: string,
    store: SessionStore,
    provider: ChatProvider,
    model: ModelConfig,
    history: readonly Message[],
    options: SessionOptions,
  ) {
    this.#agentId = options.agentId;
    this.#sessionId = sessionId;
    this.#store = store;
    this.#logger = options.logger;
    this.#title = options.title;
    this.#titleModel = options.titleModel;
    this.#titleProvider = options.titleProvider ?? provider;

    const participants = new ConversationParticipants(
      history
        .filter((message): message is UserMessage => message.role === 'user')
        .map((message) => message.origin.principal),
    );

    this.#context = new Context(options.systemPrompt, options.compactionProvider ?? provider, {
      ...options.context,
      fullHistory: history,
      logger: options.logger,
      onAppend: (message) => {
        this.#persist(message);
      },
    });

    // Authorization and the Gate write the same timeline through one sink, so
    // "why did this call not happen" has one place to look rather than two.
    const audit = {
      authorize: (record: Parameters<DecisionAuditSink['authorize']>[0]): void => {
        this.#store.recordAuthorizationDecision(record);
      },
      record: (record: Parameters<DecisionAuditSink['record']>[0]): void => {
        this.#store.recordGateDecision(record);
      },
      resolve: (
        decisionId: string,
        resolution: PermissionResolution,
        resolvedAt: Date,
        resolvedBy?: PrincipalRef,
      ): void => {
        this.#store.resolveGateDecision(sessionId, decisionId, resolution, resolvedAt, resolvedBy);
      },
    } satisfies DecisionAuditSink;

    this.#gate = new SessionGate(
      sessionId,
      options.gate ?? { defaultVerdict: 'allow', heuristics: { enabled: false } },
      {
        audit,
        evaluators: options.gateEvaluators,
        ownerApprovalRequired: (request) =>
          participants.isShared && (request.risk === undefined || request.risk.effects.length > 0),
        passthrough: options.gate === undefined,
      },
    );
    const artifactOutputs =
      options.artifacts === undefined || options.artifactScope === undefined
        ? undefined
        : new ArtifactOutputSink(options.artifacts, options.artifactScope);
    this.#runner = new Runner(this.#context, this.#events, provider, model, {
      ...(artifactOutputs === undefined
        ? {}
        : { artifactOutputs, artifactReader: artifactOutputs }),
      audit,
      authorities: options.authorities,
      authorization: options.authorization,
      gate: this.#gate,
      logger: options.logger,
      maxIterations: options.maxIterations,
      ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
      participants,
      sessionId,
    });
  }

  /** Resumes the session when `sessionId` is given, and starts one otherwise. */
  public static async open(
    database: Database,
    provider: ChatProvider,
    model: ModelConfig,
    options: SessionOptions,
  ): Promise<Session> {
    const sessionId = options.sessionId ?? nanoid();

    // Exactly one store per session. It carries both the write queue and the
    // next sequence number, so a session handed a second one would restart the
    // sequence at zero and collide with every row already stored — which the
    // store reports and the conversation survives, silently, until the next
    // time someone looks at the transcript.
    // The store needs somewhere to report a failed write before the session
    // that owns it can exist, so the sink is handed a holder rather than one.
    const owner: { session?: Session } = {};
    const store = new SessionStore(database, {
      logger: options.logger,
      onError: (error) => {
        // Durability is gone, the conversation is not. Whoever is watching gets
        // to decide whether that is worth acting on.
        const { session } = owner;
        if (session !== undefined) session.#emit({ error, type: 'error' });
      },
    });

    const stored = options.sessionId === undefined ? undefined : await store.load(sessionId);
    if (stored === undefined) {
      await store.create(sessionId, {
        agentId: options.agentId,
        metadata: options.metadata,
        title: options.title,
      });
    } else if (stored.session.agentId !== null && stored.session.agentId !== options.agentId) {
      // A transcript carries one agent's prompt, tools and habits. Resuming it as
      // a different agent would append a second voice to it and, once history is
      // searchable across sessions, hand that agent someone else's memory.
      throw new Error(
        `Session ${sessionId} belongs to agent ${stored.session.agentId}, ` +
          `not ${options.agentId}.`,
      );
    }

    if (stored !== undefined) await store.abortUnresolvedGateDecisions(sessionId);
    const session = new Session(sessionId, store, provider, model, stored?.messages ?? [], {
      ...options,
      // A resumed session keeps the name it already has, whoever gave it. Only
      // one that has never been named is still open to being named.
      title: stored?.session.title ?? options.title,
    });
    owner.session = session;
    void session.#watchForTitle();
    return session;
  }

  /** The agent this conversation is being held with. */
  public get agentId(): string {
    return this.#agentId;
  }

  /** Everything an observer can see, from the first event of the session. */
  public get events(): AsyncGenerator<AgentEvent> {
    return this.#events.subscribe();
  }

  /** Resolves once everything this session has written has reached storage. */
  public get flushed(): Promise<void> {
    return this.#store.flushed;
  }

  /** Resolves when the current run finishes; already resolved while idle. */
  public get idle(): Promise<void> {
    return this.#runner.idle;
  }

  public get sessionId(): string {
    return this.#sessionId;
  }

  /** What this conversation is called, once it has been named. */
  public get title(): string | undefined {
    return this.#title;
  }

  public get state(): RunnerState {
    return this.#runner.state;
  }

  public getPendingPermissions(): readonly PermissionRequest[] {
    return this.#gate.listPending();
  }

  /** Authorization and gate decisions for this session, oldest first. */
  public getDecisionAudit(): Promise<readonly DecisionRecord[]> {
    return this.#store.loadDecisions(this.#sessionId);
  }

  /**
   * Answers a pending permission. `resolvedBy` has to be the principal whose run
   * asked for it — only the originator may approve, on any surface.
   */
  public resolvePermission(
    requestId: string,
    resolution: 'denied' | { approved: 'once' | 'session' },
    resolvedBy: PrincipalRef,
  ): boolean {
    return this.#gate.resolve(requestId, resolution, resolvedBy);
  }

  public abort(): Promise<boolean> {
    return this.#runner.abort();
  }

  /** The bounded working set actually sent to the model. */
  public getHistory(): readonly Message[] {
    return this.#context.getHistory();
  }

  /** Current context accounting, including the model window when it is declared. */
  public getContextUsage(): ContextUsage {
    return this.#context.getUsage();
  }

  /** The complete transcript, including everything folding and compaction replaced. */
  public getTranscript(): readonly Message[] {
    return this.#context.getFullHistory();
  }

  /** Says structured content as a principal. There is no unattributed way in. */
  public send(content: UserMessageInput, origin: MessageOrigin): void {
    this.#runner.send(toUserMessage(content, origin, 'message'));
  }

  public steer(content: UserMessageInput, origin: MessageOrigin): Promise<void> {
    return this.#runner.steer(toUserMessage(content, origin, 'steer'));
  }

  /** Ends the session and waits for what it wrote to reach storage. */
  public async stop(): Promise<void> {
    // Mark the runner stopped synchronously before Gate outcomes enqueue their
    // terminal detached results; those results are persisted but start no run.
    const stopping = this.#runner.stop();
    this.#gate.stop();
    // A name is worth having but not worth waiting for: the request is dropped
    // and the session keeps its id. Awaited all the same, so a title that did
    // arrive is queued before the flush below rather than after it.
    this.#titling.abort();
    await stopping;
    await this.#titledOnce;
    await this.#store.flushed;
  }

  /**
   * Names the session once there is something to name it after.
   *
   * The first completed run is that point: the transcript then holds what was
   * asked and what came back, which is the whole of what a title is about.
   * Watching the event log rather than hooking the runner keeps this out of the
   * turn — the reply is already delivered when the request goes out, and a slow
   * or failing titling call cannot hold up a conversation it is not part of.
   *
   * One attempt per session, not one per run. A title that keeps changing under
   * whoever is reading the list is worse than one that never arrived, and the
   * session already has an id to be found by.
   */
  async #watchForTitle(): Promise<void> {
    if (this.#title !== undefined) return;

    for await (const event of this.#events.subscribe()) {
      // A run that completed as the session was ending is not worth a request
      // whose answer has nowhere to be written.
      if (this.#titling.signal.aborted) return;
      if (event.type !== 'runCompleted' || event.status !== 'completed') continue;
      // Held before it is awaited, so a `stop()` arriving mid-request has
      // something to wait on rather than flushing storage ahead of the write.
      this.#titledOnce = this.#nameSession();
      await this.#titledOnce;
      return;
    }
  }

  /**
   * One titling request. Everything it can go wrong with — a provider that is
   * down, a model that answers with prose, a session that ended first — leaves
   * the session unnamed, which is the state it was already in.
   */
  async #nameSession(): Promise<void> {
    try {
      const title = await generateTitle({
        history: this.#context.getFullHistory(),
        logger: this.#logger,
        model: this.#titleModel,
        provider: this.#titleProvider,
        signal: this.#titling.signal,
      });
      if (title === undefined || this.#titling.signal.aborted) return;

      this.#title = title;
      this.#store.setTitle(this.#sessionId, title);
      this.#emit({ title, type: 'titled' });
    } catch (error) {
      this.#logger?.warn(
        { err: error, sessionId: this.#sessionId },
        'Could not name the session; it keeps its id.',
      );
    }
  }

  /**
   * A deferred result can land after `stop()` closed the log. The message still
   * belongs to the transcript; there is simply nobody left to tell.
   */
  #emit(event: AgentEvent): void {
    if (!this.#events.isClosed) this.#events.push(event);
  }

  #persist(message: Message): void {
    this.#store.append(this.#sessionId, message);
    this.#emit({ message, type: 'message' });
  }
}

export { Session };

export type { SessionOptions };
