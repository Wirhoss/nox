import { nanoid } from 'nanoid';

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

import type { DecisionAuditSink } from '../auth/audit';
import type { AuthorityCatalog } from '../auth/authority';
import type { AuthorizationProvider } from '../auth/authorization';
import type { MessageOrigin, PrincipalRef } from '../auth/principal';
import type { Database } from '../database/database';
import type { Logger } from '../logger/logger';
import type { ModelConfig } from '../provider/config';
import type { ChatProvider } from '../provider/provider';
import type { Message, UserMessage } from './context/message';
import type { ContextOptions } from './context/options';
import type { AgentEvent } from './events';

interface SessionOptions extends RunnerOptions {
  /** The agent holding the conversation, stored so the transcript stays attributable. */
  agentId: string;
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
  title?: string;
}

function toUserMessage(text: string, origin: MessageOrigin): UserMessage {
  return {
    content: [{ text, type: 'text' }],
    createdAt: new Date(),
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
  readonly #gate?: SessionGate;
  readonly #runner: Runner;
  readonly #sessionId: string;
  readonly #store: SessionStore;

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
    this.#runner = new Runner(this.#context, this.#events, provider, model, {
      audit,
      authorities: options.authorities,
      authorization: options.authorization,
      gate: this.#gate,
      logger: options.logger,
      maxIterations: options.maxIterations,
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
    owner.session = new Session(sessionId, store, provider, model, stored?.messages ?? [], options);
    return owner.session;
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

  public get state(): RunnerState {
    return this.#runner.state;
  }

  public getPendingPermissions(): readonly PermissionRequest[] {
    return this.#gate?.listPending() ?? Object.freeze([]);
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
    return this.#gate?.resolve(requestId, resolution, resolvedBy) ?? false;
  }

  public abort(): Promise<boolean> {
    return this.#runner.abort();
  }

  /** The bounded working set actually sent to the model. */
  public getHistory(): readonly Message[] {
    return this.#context.getHistory();
  }

  /** The complete transcript, including everything folding and compaction replaced. */
  public getTranscript(): readonly Message[] {
    return this.#context.getFullHistory();
  }

  /** Says something as a principal. There is no unattributed way in. */
  public send(text: string, origin: MessageOrigin): void {
    this.#runner.send(toUserMessage(text, origin));
  }

  public steer(text: string, origin: MessageOrigin): Promise<void> {
    return this.#runner.steer(toUserMessage(text, origin));
  }

  /** Ends the session and waits for what it wrote to reach storage. */
  public async stop(): Promise<void> {
    // Mark the runner stopped synchronously before Gate outcomes enqueue their
    // terminal detached results; those results are persisted but start no run.
    const stopping = this.#runner.stop();
    this.#gate?.stop();
    await stopping;
    await this.#store.flushed;
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
