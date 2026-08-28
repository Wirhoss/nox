import {
  type ChatProvider,
  contentToString,
  fenceUntrustedText,
  isProviderError,
  type Memory,
  type MemoryMessage,
  type Message,
  type MessageContent,
  type ModelConfig,
  prepareToolCall,
  type ProviderError,
  type RecalledMemory,
  type ToolCallMessage,
  type ToolContext,
  type ToolExecution,
  type ToolExecutionSubject,
  type ToolOutputTrust,
  type ToolResponseExecution,
  type ToolResponseMessage,
  type Usage,
  type UserMessage,
} from '@nox/extension-api';
import { nanoid } from 'nanoid';

import {
  type AuthorizationDecision,
  type AuthorizationProvider,
  authorize,
} from '../auth/authorization';
import { ConversationParticipants } from '../auth/conversation';
import { ARTIFACT_ATTACH_AUTHORITY, ARTIFACT_READ_AUTHORITY } from '../auth/coreAuthorities';
import {
  messageAuthority,
  type RunAuthority,
  samePrincipal,
  SYSTEM_CRON,
  SYSTEM_INTERNAL,
  SYSTEM_ISSUER,
  systemAuthority,
} from '../auth/principal';
import { ATTACH_ARTIFACT_TOOL_NAME, READ_ARTIFACT_TOOL_NAME } from './artifactTool';
import { freezeMessage, freezeValue } from './context/immutable';

import type { ArtifactContentReader, ArtifactOutputHost } from '../artifact/output';
import type { ArtifactRef } from '../artifact/types';
import type { DecisionAuditSink } from '../auth/audit';
import type { AuthorityCatalog, GrantPattern } from '../auth/authority';
import type { Logger } from '../logger/logger';
import type {
  GateRequest,
  PendingPermission,
  PermissionResolution,
  SessionGate,
} from '../tool/gate';
import type { EventLog } from '../utils/eventLog';
import type { Context } from './context/context';
import type { AgentEvent, RunStatus, RunTrigger } from './events';

const DEFAULT_MAX_ITERATIONS = 90;
const DEFAULT_MEMORY_MAX_TOKENS = 2048;
// Matches the context engine's conservative fallback estimator; backend token
// accounting is advisory and a result that overran it is still bounded here.
const MEMORY_CHARS_PER_TOKEN = 3;
/** Cron is a trusted system ingress; the selected blueprint remains its tool boundary. */
const SYSTEM_CRON_GRANTS: readonly GrantPattern[] = Object.freeze(['*']);

type RunnerState = 'idle' | 'running' | 'stopped';

interface RunnerOptions {
  logger?: Logger;
  /** `'unlimited'` runs until the model stops asking for tools. At your risk. */
  maxIterations?: 'unlimited' | number;
}

interface RunnerConstructionOptions extends RunnerOptions {
  /** The agent and gateway metadata exposed to host-executed tools. */
  agentId: string;
  metadata?: Readonly<Record<string, unknown>>;
  /** The zone this installation reads clocks in; timestamps shown to the model use it. */
  timeZone?: string;
  /** Host-bound file output. Absent for internal or deliberately text-only sessions. */
  artifactOutputs?: ArtifactOutputHost;
  /** Privileged storage reader, narrowed by the runner to conversation-known artifact IDs. */
  artifactReader?: ArtifactContentReader;
  /**
   * Whether an artifact was ever handed to any transcript this agent holds.
   *
   * Separate from `artifactOutputs`, which answers about the conversation that
   * produced an artifact. This one answers about the agent that received it,
   * which is the only reason a session may read what an earlier session of its
   * own was given.
   */
  artifactHistory?: (artifactId: string) => Promise<boolean>;
  /** Where both halves of the decision pipeline write their one timeline. */
  audit?: DecisionAuditSink;
  /** Every authority this Nox knows. Absent means nothing can be authorized. */
  authorities?: AuthorityCatalog;
  /**
   * Consulted per tool call, never snapshotted: the tool catalog is stable for a
   * conversation, but who may use what can change while it is still going.
   * Absent is not permissive — it denies, like every other unanswered question.
   */
  authorization?: AuthorizationProvider;
  gate?: SessionGate;
  /** At most one memory is attached to an agent generation. */
  memory?: Memory;
  memoryMaxTokens?: number;
  participants?: ConversationParticipants;
  sessionId: string;
}

/**
 * Something waiting to enter the context, and the authority it would run under.
 *
 * A run takes the authority of the item that started it and keeps it to the end.
 * Anything that joins the queue afterwards is context, not authority: in a shared
 * conversation other people keep talking, and a run does not change hands because
 * somebody spoke into it.
 */
interface QueuedMessage {
  readonly authority: RunAuthority;
  /** Run-local grants carried only by trusted scheduled ingress. */
  readonly authorityGrants?: readonly GrantPattern[];
  /** Commands can wake a retry without manufacturing a transcript message. */
  readonly message?: Message;
  /**
   * Context, never a turn. It carries an authority so the transcript can say who
   * spoke, and that authority is never the one a run executes under: an
   * observation is drained into the context at the next opening and starts
   * nothing.
   */
  readonly observation?: true;
  readonly responseAttachments?: readonly ArtifactRef[];
  readonly trigger: RunTrigger;
}

type PendingOperationState = 'awaitingApproval' | 'discarded' | 'executing' | 'settled';

interface PendingOwnedOperation {
  readonly authority: RunAuthority;
  readonly authorityGrants?: readonly GrantPattern[];
  readonly call: ToolCallMessage;
  readonly execution: ToolExecution;
  readonly pendingResponseId: string;
  readonly publish: () => void;
  readonly responseAttachments: Map<string, ArtifactRef>;
  readonly runId: string;
  readonly subject: ToolExecutionSubject;
  readonly whenPublished: Promise<void>;
  completion?: ToolResponseMessage;
  published: boolean;
  state: PendingOperationState;
}

type PermissionWait =
  | { readonly resolution: PermissionResolution; readonly type: 'resolution' }
  | { readonly type: 'shared' };

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function resolveMemoryMaxTokens(maxTokens: number | undefined): number {
  if (maxTokens === undefined) return DEFAULT_MEMORY_MAX_TOKENS;
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new RangeError('memoryMaxTokens must be a positive integer.');
  }
  return maxTokens;
}

function resolveMaxIterations(maxIterations: RunnerOptions['maxIterations']): number {
  if (maxIterations === undefined) return DEFAULT_MAX_ITERATIONS;
  if (maxIterations === 'unlimited') return Number.POSITIVE_INFINITY;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new RangeError('maxIterations must be a positive integer or "unlimited".');
  }
  return maxIterations;
}

/** Human turns may absorb more speech from the same principal; system causes never merge. */
function sameRunOwner(left: RunAuthority, right: RunAuthority): boolean {
  if (!samePrincipal(left.principal, right.principal)) return false;
  if (left.source.type === 'system' || right.source.type === 'system') {
    return (
      left.source.type === 'system' &&
      right.source.type === 'system' &&
      left.source.causeId === right.source.causeId
    );
  }
  return true;
}

/** Projects only original speech and settled replies; reasoning and derived context never leave Nox. */
function memoryMessages(messages: readonly Message[]): MemoryMessage[] {
  return messages.flatMap((message): MemoryMessage[] => {
    if (message.role !== 'assistant' && message.role !== 'user') return [];
    const text = contentToString(message.content).trim();
    if (text.length === 0) return [];
    return [
      Object.freeze({
        createdAt: new Date(message.createdAt.getTime()),
        messageId: message.messageId,
        ...(message.role === 'user'
          ? {
              principal: Object.freeze({ ...message.origin.principal }),
              role: 'user' as const,
            }
          : { role: 'assistant' as const }),
        text,
      }),
    ];
  });
}

/** A second line of defence if a contributed adapter ignores the requested token budget. */
function renderMemories(memories: readonly RecalledMemory[], maxTokens: number): string {
  let remaining = Math.max(1, maxTokens) * MEMORY_CHARS_PER_TOKEN;
  const rendered: string[] = [];

  for (const [index, memory] of memories.entries()) {
    if (typeof memory.text !== 'string') continue;
    const text = memory.text.trim();
    if (text.length === 0) continue;

    const references = [
      typeof memory.id === 'string' && memory.id.length > 0 ? `id=${memory.id}` : undefined,
      typeof memory.uri === 'string' && memory.uri.length > 0 ? `uri=${memory.uri}` : undefined,
    ].filter((value): value is string => value !== undefined);
    const header = `Memory ${String(index + 1)}${references.length === 0 ? '' : ` (${references.join(', ')})`}:\n`;
    if (header.length >= remaining) break;

    const available = remaining - header.length;
    const body = text.length > available ? text.slice(0, available) : text;
    rendered.push(header + body);
    remaining -= header.length + body.length;
    if (remaining <= 0) break;
  }

  return rendered.join('\n\n');
}

/**
 * The engine of a session: one long-lived runner, one queue, one run at a time.
 *
 * Everything that wants to reach the model goes on the same queue — replies the
 * user sent and results deferred tools finished — and the loop drains it at the
 * top of every iteration, right before the request. That is what makes idleness
 * safe to act on: a run only ends with the queue empty, so a result landing
 * mid-run is never left unseen, and only a result landing while idle has to
 * wake anything.
 */
class Runner {
  readonly #agentId: string;
  readonly #artifactOutputs?: ArtifactOutputHost;
  readonly #artifactHistory?: (artifactId: string) => Promise<boolean>;
  readonly #artifactReader?: ArtifactContentReader;
  readonly #timeZone?: string;
  readonly #audit?: DecisionAuditSink;
  readonly #authorities?: AuthorityCatalog;
  readonly #authorization?: AuthorizationProvider;
  readonly #context: Context;
  readonly #events: EventLog<AgentEvent>;
  readonly #gate?: SessionGate;
  readonly #logger?: Logger;
  readonly #maxIterations: number;
  readonly #memory?: Memory;
  readonly #memoryMaxTokens: number;
  readonly #memoryTasks = new Set<Promise<void>>();
  readonly #metadata: Readonly<Record<string, unknown>>;
  readonly #model: ModelConfig;
  readonly #participants: ConversationParticipants;
  readonly #pendingOperations = new Map<string, PendingOwnedOperation>();
  readonly #provider: ChatProvider;
  readonly #responseAttachments = new Map<string, ArtifactRef>();
  readonly #sessionId: string;

  /** Waiting to enter the context: user messages and deferred results alike. */
  readonly #queue: QueuedMessage[] = [];

  /** Outlives every run, so background work survives a foreground `abort()`. */
  readonly #session = new AbortController();

  #run?: AbortController;
  #idle: Promise<void> = Promise.resolve();
  #resolveIdle?: () => void;
  #runAuthority?: RunAuthority;
  #recalledMemory?: UserMessage;
  #memoryAnchorId?: string;
  #memoryQuerySignature?: string;
  #runAuthorityGrants?: readonly GrantPattern[];
  #runId?: string;
  #runTranscriptStart = 0;
  #state: RunnerState = 'idle';

  constructor(
    context: Context,
    events: EventLog<AgentEvent>,
    provider: ChatProvider,
    model: ModelConfig,
    options: RunnerConstructionOptions,
  ) {
    this.#agentId = options.agentId;
    this.#artifactOutputs = options.artifactOutputs;
    this.#artifactHistory = options.artifactHistory;
    this.#artifactReader = options.artifactReader;
    this.#timeZone = options.timeZone;
    this.#audit = options.audit;
    this.#authorities = options.authorities;
    this.#authorization = options.authorization;
    this.#context = context;
    this.#events = events;
    this.#provider = provider;
    this.#model = model;
    this.#gate = options.gate;
    this.#logger = options.logger;
    this.#maxIterations = resolveMaxIterations(options.maxIterations);
    this.#memory = options.memory;
    this.#memoryMaxTokens = resolveMemoryMaxTokens(options.memoryMaxTokens);
    this.#metadata = Object.freeze({ ...options.metadata });
    this.#participants =
      options.participants ??
      new ConversationParticipants(
        context
          .getFullHistory()
          .filter((message): message is UserMessage => message.role === 'user')
          .map((message) => message.origin.principal),
      );
    this.#sessionId = options.sessionId;
  }

  /** Resolves when the current run finishes; already resolved while idle. */
  public get idle(): Promise<void> {
    return this.#idle;
  }

  public get isRunning(): boolean {
    return this.#state === 'running';
  }

  public get state(): RunnerState {
    return this.#state;
  }

  /** Aborts the run in flight. False if there was nothing to abort. */
  public async abort(): Promise<boolean> {
    if (this.#state !== 'running') return false;

    this.#run?.abort();
    await this.#idle;
    return true;
  }

  /**
   * Queues a message, and wakes the runner if nothing is running. The authority
   * comes from the message's own authenticated origin, and from nowhere else.
   */
  public send(message: UserMessage): void {
    this.#participants.observe(message.origin.principal);
    this.#enqueue({
      authority: messageAuthority(message.origin, message.messageId),
      message,
      trigger: 'user',
    });
  }

  /**
   * Queues new direction without cancelling the operation in flight. The run
   * drains it at the next safe opening, after the current provider request and
   * its tool responses have settled.
   */
  public steer(message: UserMessage): Promise<void> {
    this.#participants.observe(message.origin.principal);
    this.#enqueue({
      authority: messageAuthority(message.origin, message.messageId),
      message,
      trigger: 'steer',
    });
    return Promise.resolve();
  }

  /** Wakes the model from current settled context without appending a message. */
  public retry(authority: RunAuthority): Promise<void> {
    if (this.#state === 'stopped') throw new Error('A stopped session cannot be retried.');
    if (this.#state === 'running') throw new Error('A running session cannot be retried.');
    this.#enqueue({ authority, trigger: 'retry' });
    return this.#idle;
  }

  /**
   * Records something said in the conversation that was not said to Nox.
   *
   * It never wakes the runner and never joins the run in flight. Idle, it goes
   * straight into the context, because there is nothing for it to race. Running,
   * it waits in the queue and is drained at the next opening — injecting into a
   * turn while its context is being assembled is exactly the race `#drainOwn`
   * exists to avoid, and an observation is in no hurry.
   *
   * The speaker is observed as a participant regardless. That is the whole point:
   * a transcript that now contains a second person's words is a shared
   * conversation, whether or not they were talking to the agent.
   */
  public observe(message: UserMessage): void {
    this.#participants.observe(message.origin.principal);

    if (this.#state !== 'running') {
      this.#context.addMessage(message);
      return;
    }

    this.#queue.push({
      authority: messageAuthority(message.origin, message.messageId),
      message,
      observation: true,
      trigger: 'user',
    });
  }

  /** Wakes this fresh session as Nox's cron principal. */
  public schedule(message: UserMessage, causeId: string): void {
    this.#participants.observe(SYSTEM_CRON);
    this.#enqueue({
      authority: systemAuthority(SYSTEM_CRON, causeId),
      authorityGrants: SYSTEM_CRON_GRANTS,
      message,
      trigger: 'cron',
    });
  }

  /**
   * Ends the session for good: the run in flight is aborted, background work is
   * cancelled and the event log closes. A runner cannot be restarted.
   */
  public async stop(): Promise<void> {
    if (this.#state === 'stopped') return;

    // Stop background and pending work before waiting for the foreground run;
    // otherwise continuing the queue after an abort could start another turn
    // while the session is trying to close.
    this.#session.abort();
    this.#run?.abort();
    this.#state = 'stopped';
    await this.#idle;
    await Promise.all([...this.#memoryTasks]);
    this.#events.close();
  }

  /**
   * Takes the longest run of queued entries this run is entitled to absorb, and
   * stops at the first one belonging to somebody else.
   *
   * This is the whole of what keeps one principal's words out of another's run.
   * A run's authority is fixed when it starts, so anything it swallows is read
   * by the model *under that authority* — which means a message from Bob landing
   * mid-turn could ask for a tool and have it authorized as Alice. It waits for
   * its own run instead.
   *
   * It stops at the first foreign entry rather than picking its own out of the
   * middle, because the transcript is a record of a conversation and reordering
   * who spoke when to suit whose turn it is would make it a false one.
   */
  #drainOwn(authority: RunAuthority): void {
    let owned = 0;
    while (owned < this.#queue.length) {
      const entry = this.#queue[owned];
      if (entry === undefined || !sameRunOwner(entry.authority, authority)) break;
      owned += 1;
    }

    for (const { message, responseAttachments } of this.#queue.splice(0, owned)) {
      if (message !== undefined) this.#context.addMessage(message);
      for (const artifact of responseAttachments ?? []) {
        this.#responseAttachments.set(artifact.artifactId, artifact);
      }
    }
  }

  /**
   * The next entry that is actually a turn, with everything that is only context
   * absorbed on the way to it. Observations at the head of the queue are drained
   * rather than run: nobody asked Nox for anything by saying them.
   */
  #nextTurn(): QueuedMessage | undefined {
    while (this.#queue[0]?.observation === true) {
      const entry = this.#queue.shift();
      if (entry?.message !== undefined) this.#context.addMessage(entry.message);
    }
    return this.#queue[0];
  }

  /** Empties the queue into the context. Never starts anything. */
  #drainAll(): void {
    for (const { message } of this.#queue.splice(0)) {
      if (message !== undefined) this.#context.addMessage(message);
    }
  }

  /** Whether the queue starts with something this run may still take. */
  #hasOwnQueued(authority: RunAuthority): boolean {
    const next = this.#queue[0];
    return next !== undefined && sameRunOwner(next.authority, authority);
  }

  #enqueue(entry: QueuedMessage): void {
    // A late result still belongs to the transcript, which is permanent and
    // complete; dropping it to save the trouble would be deleting it.
    if (this.#state === 'stopped') {
      if (entry.message !== undefined) this.#context.addMessage(entry.message);
      return;
    }

    this.#queue.push(entry);
    if (this.#state === 'running') return;

    void this.#execute().catch((error: unknown) => {
      // #execute reports failures as events; nobody may be subscribed, so the
      // log is the backstop rather than an unhandled rejection.
      this.#logger?.error({ err: error }, 'Agent run failed.');
    });
  }

  /**
   * Drains the queue as a chain of runs, one per principal in the order they
   * spoke, and stays busy until nothing is left.
   *
   * A turn that ends with somebody else's message waiting is not the end of the
   * work — it is the end of *that person's* work. Chaining here rather than
   * returning to idle is what makes `idle` still mean "the conversation has
   * caught up" now that one queue can hold several people's turns.
   */
  async #execute(): Promise<void> {
    // Set before the first await: a second enqueue in this same tick has to see
    // a running runner, or it would start a second run.
    this.#state = 'running';
    this.#idle = new Promise<void>((resolve) => {
      this.#resolveIdle = resolve;
    });

    try {
      for (let next = this.#nextTurn(); next !== undefined; next = this.#nextTurn()) {
        const status = await this.#runTurn(next.authority, next.trigger, next.authorityGrants);
        if (this.#session.signal.aborted) break;

        if (status === 'aborted') {
          // Abort cancels the current owner's turn, not unrelated work already
          // requested by another principal. Same-owner messages that arrived in
          // the interrupted turn are recorded without silently restarting it.
          this.#drainOwn(next.authority);
        }
        // A provider failure is local to its run. The next queued item explicitly
        // requested its own run and must not be consumed as collateral damage.
      }
    } finally {
      // Session shutdown may leave entries behind. They still belong to the
      // append-only transcript, but a stopped runner starts no further work.
      this.#drainAll();
      this.#runAuthority = undefined;
      this.#runAuthorityGrants = undefined;
      this.#runId = undefined;
      this.#state = this.#session.signal.aborted ? 'stopped' : 'idle';
      this.#resolveIdle?.();
    }
  }

  /** One run, under one authority, from one entry on the queue. */
  async #runTurn(
    authority: RunAuthority,
    trigger: RunTrigger,
    authorityGrants?: readonly GrantPattern[],
  ): Promise<RunStatus> {
    this.#run = new AbortController();
    this.#responseAttachments.clear();

    const runId = nanoid();
    // Fixed here and read by every tool call this run makes. Nothing that lands
    // in the queue afterwards can move it.
    this.#runAuthority = authority;
    this.#runAuthorityGrants = authorityGrants;
    this.#runId = runId;
    this.#runTranscriptStart = this.#context.getFullHistory().length;
    this.#recalledMemory = undefined;
    this.#memoryAnchorId = undefined;
    this.#memoryQuerySignature = undefined;
    const startedAt = new Date();
    const usage: Usage = { cacheReadTokens: 0, inputTokens: 0, outputTokens: 0 };

    this.#events.push({
      authority,
      modelId: this.#model.modelId,
      runId,
      startedAt,
      trigger,
      type: 'runStarted',
    });

    try {
      const status = await this.#runLoop(usage);
      const completedAt = new Date();
      this.#finish(runId, status, startedAt, usage);
      this.#retainTurn(runId, status, trigger, startedAt, completedAt, authority);
      return status;
    } catch (error) {
      const failure = toError(error);
      // Any permission detached from partial provider output must close before
      // that uncommitted call can ever execute.
      this.#run.abort(failure);
      this.#discardUnpublishedOperations(runId);
      this.#flushResponseAttachments();
      this.#logger?.error({ err: failure, modelId: this.#model.modelId }, 'Agent run failed.');
      this.#events.push({ error: failure, type: 'error' });
      const completedAt = new Date();
      this.#finish(runId, 'failed', startedAt, usage);
      this.#retainTurn(runId, 'failed', trigger, startedAt, completedAt, authority);
      return 'failed';
    } finally {
      this.#responseAttachments.clear();
      this.#recalledMemory = undefined;
      this.#memoryAnchorId = undefined;
      this.#memoryQuerySignature = undefined;
      this.#run = undefined;
    }
  }

  #finish(runId: string, status: RunStatus, startedAt: Date, usage: Usage): void {
    this.#events.push({
      durationMs: Date.now() - startedAt.getTime(),
      runId,
      status,
      type: 'runCompleted',
      usage,
    });
  }

  /**
   * One request to the model. Tools start as their calls arrive rather than
   * after the stream closes, so a slow tool overlaps the rest of the reply.
   */
  async #request(usage: Usage): Promise<ToolResponseMessage[]> {
    // Usage reported at the end belongs to this exact input snapshot, not to
    // the assistant output or tool results appended while the call is running.
    const requestHistory = this.#historyWithMemory();
    const requestTokenEstimate =
      this.#context.getTokenEstimate() +
      (this.#recalledMemory === undefined
        ? 0
        : this.#context.estimateMessages([this.#recalledMemory]));
    const signal = this.#runSignal();
    const artifactOutput = this.#artifactOutputs?.publisher(
      {
        details: {
          modelId: this.#model.modelId,
          runId: this.#currentRunId(),
          sessionId: this.#sessionId,
        },
        type: 'provider',
      },
      signal,
    );
    const stream = this.#provider.getMessageStream(
      this.#context.getSystemPrompt(),
      requestHistory,
      Object.values(this.#context.getTools()),
      {
        ...(artifactOutput === undefined ? {} : { artifactOutput }),
        ...(this.#timeZone === undefined ? {} : { timeZone: this.#timeZone }),
        model: this.#model,
        signal,
      },
    );

    const responses: Promise<ToolResponseMessage>[] = [];
    let failure: ProviderError | undefined;

    for await (const event of stream) {
      switch (event.type) {
        case 'end': {
          if (event.usage !== undefined) {
            this.#context.recordInputUsage(event.usage.inputTokens, requestTokenEstimate);
            this.#recordUsage(usage, event.usage);
          }
          const messages =
            responses.length === 0 ? this.#withResponseAttachments(event.messages) : event.messages;
          for (const message of messages) this.#context.addMessage(message);
          break;
        }
        case 'error': {
          failure = event.error;
          break;
        }
        case 'reasoningFragment': {
          this.#events.push({ text: event.text, type: 'assistantReasoningFragment' });
          break;
        }
        case 'retry': {
          this.#events.push({
            attempt: event.attempt,
            delayMs: event.delayMs,
            error: event.error,
            type: 'retry',
          });
          break;
        }
        case 'textFragment': {
          this.#events.push({ text: event.text, type: 'assistantTextFragment' });
          break;
        }
        case 'toolCall': {
          responses.push(this.#runTool(event.toolCall));
          break;
        }
      }
    }

    // Awaited first: a tool call without its response is an invalid request, so
    // even a failed or aborted stream leaves the pairs closed.
    const settled = await Promise.all(responses);
    if (failure !== undefined) throw failure;
    return settled;
  }

  #historyWithMemory(): Message[] {
    const history = [...this.#context.getHistory()];
    const memory = this.#recalledMemory;
    if (memory === undefined) return history;

    const anchor = this.#memoryAnchorId;
    const index =
      anchor === undefined ? -1 : history.findIndex((message) => message.messageId === anchor);
    if (index === -1) history.unshift(memory);
    else history.splice(index, 0, memory);
    return history;
  }

  /** Recalls once per distinct set of user messages absorbed by the current run. */
  async #recall(): Promise<void> {
    const memory = this.#memory;
    if (memory === undefined) return;

    const authority = this.#authority();
    const transcript = this.#context.getFullHistory();
    const turn = memoryMessages(transcript.slice(this.#runTranscriptStart));
    let queries = turn.filter(
      (message) =>
        message.role === 'user' &&
        message.principal !== undefined &&
        samePrincipal(message.principal, authority.principal),
    );
    let recallContext = turn.filter(
      (message) =>
        message.role === 'assistant' ||
        (message.principal !== undefined && samePrincipal(message.principal, authority.principal)),
    );

    if (queries.length === 0) {
      const fallback = memoryMessages(transcript).findLast(
        (message) =>
          message.role === 'user' &&
          message.principal !== undefined &&
          samePrincipal(message.principal, authority.principal),
      );
      if (fallback === undefined) return;
      queries = [fallback];
      recallContext = [fallback];
    }

    const signature = queries.map((message) => message.messageId).join('\u0000');
    if (this.#memoryQuerySignature === signature) return;
    this.#memoryQuerySignature = signature;
    this.#recalledMemory = undefined;
    this.#memoryAnchorId = queries[0]?.messageId;

    const signal = this.#runSignal();
    try {
      const result = await memory.recall({
        context: Object.freeze(recallContext),
        maxTokens: this.#memoryMaxTokens,
        query: queries.map((message) => message.text).join('\n\n'),
        scope: Object.freeze({
          agentId: this.#agentId,
          metadata: this.#metadata,
          principal: Object.freeze({ ...authority.principal }),
          sessionId: this.#sessionId,
        }),
        signal,
      });
      if (!Array.isArray(result.memories)) {
        throw new TypeError('Memory recall returned no memories array.');
      }

      const rendered = renderMemories(result.memories, this.#memoryMaxTokens);
      if (rendered.length === 0) return;
      const runId = this.#currentRunId();
      this.#recalledMemory = freezeMessage<UserMessage>({
        content: [
          {
            text:
              '[Nox runtime record: relevant long-term memory, retrieved for this request only.]\n' +
              fenceUntrustedText(rendered),
            type: 'text',
          },
        ],
        createdAt: new Date(),
        delivery: 'observation',
        messageId: `memory-${runId}`,
        origin: {
          principal: SYSTEM_INTERNAL,
          transportMessageId: `memory-${runId}`,
        },
        role: 'user',
      });
    } catch (error) {
      if (!signal.aborted) {
        this.#logger?.warn(
          { agentId: this.#agentId, err: error, sessionId: this.#sessionId },
          'Could not recall long-term memory; continuing without it.',
        );
      }
    }
  }

  /** Retention is isolated from the turn and drained only when the session stops. */
  #retainTurn(
    runId: string,
    status: RunStatus,
    trigger: RunTrigger,
    startedAt: Date,
    completedAt: Date,
    authority: RunAuthority,
  ): void {
    const memory = this.#memory;
    if (memory === undefined) return;

    const messages = memoryMessages(
      this.#context.getFullHistory().slice(this.#runTranscriptStart),
    ).filter(
      (entry) =>
        entry.role === 'assistant' ||
        (entry.principal !== undefined && samePrincipal(entry.principal, authority.principal)),
    );
    if (messages.length === 0) return;

    const pending = Promise.resolve()
      .then(() =>
        memory.retain({
          completedAt,
          messages: Object.freeze(messages),
          runId,
          scope: Object.freeze({
            agentId: this.#agentId,
            metadata: this.#metadata,
            principal: Object.freeze({ ...authority.principal }),
            sessionId: this.#sessionId,
          }),
          startedAt,
          status,
          trigger,
        }),
      )
      .catch((error: unknown) => {
        this.#logger?.warn(
          { agentId: this.#agentId, err: error, runId, sessionId: this.#sessionId },
          'Could not retain long-term memory; the conversation remains available.',
        );
      });
    this.#memoryTasks.add(pending);
    void pending.finally(() => {
      this.#memoryTasks.delete(pending);
    });
  }

  #recordUsage(total: Usage, call: Usage): void {
    total.cacheReadTokens = (total.cacheReadTokens ?? 0) + (call.cacheReadTokens ?? 0);
    total.inputTokens += call.inputTokens;
    total.outputTokens += call.outputTokens;
    this.#events.push({ type: 'usage', usage: call });
  }

  #withResponseAttachments(messages: readonly Message[]): Message[] {
    if (this.#responseAttachments.size === 0) return [...messages];

    const attached = new Set(
      messages.flatMap((message) =>
        message.role === 'assistant'
          ? message.content.flatMap((part) =>
              part.type === 'artifact' ? [part.artifact.artifactId] : [],
            )
          : [],
      ),
    );
    const output = [...this.#responseAttachments.values()].filter(
      (artifact) => !attached.has(artifact.artifactId),
    );
    this.#responseAttachments.clear();
    if (output.length === 0) return [...messages];

    const result = [...messages];
    const target = result.findLastIndex((message) => message.role === 'assistant');
    const parts = output.map((artifact) => ({ artifact, type: 'artifact' as const }));
    const assistant = result[target];
    if (assistant?.role === 'assistant') {
      result[target] = { ...assistant, content: [...assistant.content, ...parts] };
    } else {
      result.push({
        content: parts,
        createdAt: new Date(),
        messageId: nanoid(),
        role: 'assistant',
      });
    }
    return result;
  }

  #flushResponseAttachments(): void {
    for (const message of this.#withResponseAttachments([])) this.#context.addMessage(message);
  }

  async #runLoop(usage: Usage): Promise<RunStatus> {
    const authority = this.#authority();

    for (let iteration = 0; iteration < this.#maxIterations; iteration++) {
      this.#drainOwn(authority);
      await this.#context.compact();
      await this.#recall();

      const responses = await this.#requestWithinBudget(usage);
      for (const response of responses) {
        this.#context.addMessage(response);
        this.#publishPendingOperation(response.messageId);
      }

      if (this.#runSignal().aborted) {
        this.#flushResponseAttachments();
        return 'aborted';
      }

      if (responses.length === 0) {
        // The model answered instead of asking for another tool, so it has
        // consumed the results and this run's mechanical traffic is settled.
        // Folding it here is deterministic and lossless — the originals stay in
        // the transcript — and a fold that reclaims too little to pay for the
        // head rewrite is rejected inside the context.
        await this.#context.fold();
        if (!this.#hasOwnQueued(authority)) return 'completed';
      }
    }

    // Explicitly selected output survives even when the model never got one final
    // turn to mention it; the iteration ceiling must not make that choice vanish.
    this.#flushResponseAttachments();

    // Not a failure, but the reply is probably cut off mid-thought.
    this.#logger?.warn(
      { maxIterations: this.#maxIterations },
      'Agent run hit the tool iteration ceiling.',
    );
    return 'maxIterations';
  }

  /**
   * The provider is the authority on what fits. A refusal for length is not a
   * failed run: it is the measurement that proves the local estimate wrong, and
   * the only answer to it is to reduce and ask again. A length refusal rejects
   * the request before any of it streams back, so nothing of the turn was
   * committed and the retry re-asks from an unchanged history.
   *
   * Once. A pass that reclaimed nothing will reclaim nothing the second time,
   * and the run has genuinely run out of room.
   */
  async #requestWithinBudget(usage: Usage): Promise<ToolResponseMessage[]> {
    try {
      return await this.#request(usage);
    } catch (error) {
      if (!isProviderError(error) || error.code !== 'context_limit') throw error;
      let refusal = error;

      // Recalled context is optional and ephemeral. It is the first thing to
      // remove when the provider proves the estimate wrong; memory must never
      // turn an otherwise valid user turn into a failed one.
      if (this.#recalledMemory !== undefined) {
        this.#recalledMemory = undefined;
        this.#logger?.warn(
          { err: error, modelId: this.#model.modelId },
          'Provider refused a request containing memory; retried without recalled context.',
        );
        try {
          return await this.#request(usage);
        } catch (retryError) {
          if (!isProviderError(retryError) || retryError.code !== 'context_limit') throw retryError;
          refusal = retryError;
        }
      }

      const { reduced } = await this.#context.compact({ force: true });
      if (!reduced) throw refusal;

      this.#logger?.warn(
        { err: refusal, modelId: this.#model.modelId },
        'Provider refused the request for length; reduced the working set and retried.',
      );
      return await this.#request(usage);
    }
  }

  #runSignal(): AbortSignal {
    return this.#run?.signal ?? this.#session.signal;
  }

  async #runTool(sourceCall: ToolCallMessage): Promise<ToolResponseMessage> {
    const call = freezeMessage(sourceCall);
    const tool = this.#context.getTools()[call.name];
    if (tool === undefined) {
      // The model asked for something it was never given: a wiring problem.
      this.#logger?.warn({ toolName: call.name }, 'Tool call requested an unknown tool.');
      return this.#noxResponse(call, 'immediate', `Tool ${call.name} not found.`, true);
    }

    const startedAt = Date.now();
    try {
      // Preparation is side-effect free by contract, which is what makes it safe
      // to run before anyone has decided this call may happen at all. Everything
      // needed to decide — authority, risk, params, preview — exists by now.
      const prepared = prepareToolCall(tool, call.arguments);
      const execution = freezeValue(prepared.execution);
      const subject = execution.gateSubject;
      if (subject === undefined) {
        // A tool reached the model without being bound to a set, so nothing can
        // say what it is allowed to do. That is a wiring bug, and the only safe
        // reading of it is no.
        this.#logger?.error(
          { toolName: call.name },
          'Refused a tool call that carries no execution subject.',
        );
        return this.#noxResponse(
          call,
          'immediate',
          `Tool ${call.name} is not bound to a tool set, so it cannot be authorized.`,
          true,
        );
      }

      const unauthorized = await this.#authorizeCall(call, subject);
      if (unauthorized !== undefined) return unauthorized;

      const rejected = await this.#gateCall(call, execution, subject);
      if (rejected !== undefined) return rejected;

      // Deciding takes real time: a provider over the network, an evaluator, a
      // human answering a prompt. If the run was abandoned while that ran, the
      // answer arrives for something nobody is waiting on any more.
      //
      // This matters most for deferred work, which is deliberately handed the
      // session signal so it outlives an abort — without this check an aborted
      // run would still start background work, and the abort would be a lie.
      if (this.#runSignal().aborted) return this.#abortedToolResponse(call);

      const outputSignal = execution.type === 'deferred' ? this.#session.signal : this.#runSignal();
      const toolContext = this.#toolContext(
        call,
        subject,
        outputSignal,
        this.#currentRunId(),
        this.#responseAttachments,
      );

      if (execution.type === 'deferred') {
        // Authorization and the Gate are behind us, so the whole deferred
        // operation is approved. The ack and the result that follow are not new
        // executions and are never authorized again.
        const { ack, result } = await execution.run(toolContext);
        this.#trackDeferred(call, result, this.#authority(), this.#runAuthorityGrants, subject);
        this.#logger?.debug(
          { durationMs: Date.now() - startedAt, toolName: call.name },
          'Deferred tool acknowledged.',
        );
        return this.#toolOutputResponse(call, 'deferredAck', ack, subject);
      }

      const response = await execution.run(toolContext);
      this.#logger?.debug(
        { durationMs: Date.now() - startedAt, toolName: call.name },
        'Tool call completed.',
      );
      return this.#toolOutputResponse(call, 'immediate', response, subject);
    } catch (error) {
      if (this.#runSignal().aborted) return this.#abortedToolResponse(call);

      // Reported to the model as tool output, and to the operator as a log: an
      // error only the model can see is an error nobody can debug.
      this.#logger?.error(
        { durationMs: Date.now() - startedAt, err: error, toolName: call.name },
        'Tool call failed.',
      );
      return this.#noxResponse(
        call,
        'immediate',
        `Error executing tool ${call.name}: ${toError(error).message}`,
        true,
      );
    }
  }

  #toolContext(
    call: ToolCallMessage,
    subject: ToolExecutionSubject,
    signal: AbortSignal,
    runId: string,
    responseAttachmentTarget?: Map<string, ArtifactRef>,
  ): ToolContext {
    const artifacts =
      subject.output?.artifacts === true
        ? this.#artifactOutputs?.publisher(
            {
              details: {
                runId,
                sessionId: this.#sessionId,
                toolName: subject.toolName,
                toolSetId: subject.toolSetId,
                trackId: call.trackId,
              },
              type: 'tool',
            },
            signal,
          )
        : undefined;

    const mayReadArtifact =
      subject.authority === ARTIFACT_READ_AUTHORITY && subject.toolName === READ_ARTIFACT_TOOL_NAME;
    const artifactReader =
      this.#artifactReader === undefined || !mayReadArtifact
        ? undefined
        : Object.freeze({
            read: async (input: Parameters<ArtifactContentReader['read']>[0]) => {
              signal.throwIfAborted();
              // Cheapest first, and each one is a different claim to the same
              // artifact: this transcript was handed it, this conversation
              // produced it, or an earlier session of this same agent was
              // handed it. The last is what makes an artifact found through
              // `search_sessions` openable instead of a dead reference.
              const owned =
                this.#knownArtifactIds().has(input.artifactId) ||
                (await this.#artifactOutputs?.reference(input.artifactId)) !== undefined ||
                (await this.#artifactHistory?.(input.artifactId)) === true;
              if (!owned) return undefined;

              const result = await this.#artifactReader?.read(input, signal);
              signal.throwIfAborted();
              return result;
            },
          });

    const mayAttachArtifact =
      responseAttachmentTarget !== undefined &&
      subject.authority === ARTIFACT_ATTACH_AUTHORITY &&
      subject.toolName === ATTACH_ARTIFACT_TOOL_NAME;
    const responseAttachments =
      this.#artifactOutputs === undefined || !mayAttachArtifact
        ? undefined
        : Object.freeze({
            addArtifact: async (artifactId: string) => {
              signal.throwIfAborted();
              // Attaching is not reading. Reading shows the agent bytes;
              // attaching hands them to whoever is in this conversation, which
              // is a different audience from the one that produced them. So an
              // artifact this conversation does not own is not attached as
              // itself — an earlier session of this agent having received it
              // buys the right to publish a *copy* that this conversation owns
              // and that names where it came from. Nothing leaves under an
              // identity belonging to a conversation that never published it.
              const owned = await this.#artifactOutputs?.reference(artifactId);
              signal.throwIfAborted();
              const part =
                owned ??
                ((await this.#artifactHistory?.(artifactId)) === true
                  ? await this.#artifactOutputs?.adopt(artifactId, signal)
                  : undefined);
              signal.throwIfAborted();
              if (part === undefined) {
                throw new Error(
                  `Artifact ${artifactId} is not an output owned by this conversation.`,
                );
              }
              responseAttachmentTarget.set(part.artifact.artifactId, part.artifact);
              return part;
            },
          });

    return {
      abortSignal: signal,
      ...(artifactReader === undefined ? {} : { artifactReader }),
      ...(artifacts === undefined ? {} : { artifacts }),
      ...(responseAttachments === undefined ? {} : { responseAttachments }),
      session: {
        agentId: this.#agentId,
        metadata: this.#metadata,
        sessionId: this.#sessionId,
      },
      toolSetId: subject.toolSetId,
    };
  }

  #knownArtifactIds(): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const message of this.#context.getFullHistory()) {
      if (message.role === 'toolCall') continue;
      const content = message.role === 'toolResponse' ? message.response : message.content;
      for (const part of content) {
        if (part.type === 'artifact') ids.add(part.artifact.artifactId);
      }
    }
    return ids;
  }

  /**
   * The half that asks who is acting, before the half that asks what they are
   * doing. It runs on every call — including one the Gate has already memoized an
   * approval for — because a memo is about a decision somebody made, and a grant
   * can be taken away between two calls of the same conversation.
   *
   * Deliberately not a `GateEvaluator`: the Gate consults its session memo before
   * some evaluators run, so authorization living there could be skipped by an
   * approval given earlier.
   */
  async #authorizeCall(
    call: ToolCallMessage,
    subject: ToolExecutionSubject,
  ): Promise<ToolResponseMessage | undefined> {
    const runAuthority = this.#authority();
    const runId = this.#currentRunId();
    const decision = await this.#decideAuthorization(
      call,
      subject,
      runAuthority,
      runId,
      this.#runSignal(),
    );

    if (this.#runSignal().aborted) return this.#abortedToolResponse(call);
    if (decision.allowed) return undefined;

    // No permission request follows. Someone without `use` has not asked a
    // question a human could answer; there is nothing to put a button on.
    return this.#noxResponse(
      call,
      'immediate',
      `Tool call not authorized: ${decision.reason} ` +
        'Do not retry; this needs a change of permissions, not a different attempt.',
      true,
    );
  }

  async #decideAuthorization(
    call: ToolCallMessage,
    subject: ToolExecutionSubject,
    runAuthority: RunAuthority,
    runId: string,
    signal: AbortSignal,
    authorityGrants = this.#runAuthorityGrants,
  ): Promise<AuthorizationDecision> {
    const scheduled = this.#scheduledAuthorization(subject, runAuthority, authorityGrants);
    const decision =
      scheduled ??
      (await authorize(
        {
          authority: subject.authority,
          principal: runAuthority.principal,
          runId,
          sessionId: this.#sessionId,
          toolName: subject.toolName,
          toolSetId: subject.toolSetId,
          trackId: call.trackId,
        },
        this.#authorization,
        this.#authorities,
        signal,
        this.#logger,
      ));

    // Written whichever way it went. A deny never reaches the Gate, so this is
    // the only record that the call was ever attempted. An approved detached
    // operation writes a second line here when it is revalidated before run().
    this.#audit?.authorize({
      authority: subject.authority,
      createdAt: new Date(),
      decidedBy: decision.decidedBy,
      decisionId: nanoid(),
      matchedGrant: decision.matchedGrant,
      params: subject.params,
      principal: runAuthority.principal,
      reason: decision.reason,
      runId,
      sessionId: this.#sessionId,
      toolName: subject.toolName,
      toolSetId: subject.toolSetId,
      trackId: call.trackId,
      verdict: decision.allowed ? 'allow' : 'deny',
    });
    this.#emit({
      authority: subject.authority,
      decision,
      principal: runAuthority.principal,
      runId,
      toolName: subject.toolName,
      trackId: call.trackId,
      type: 'authorizationDecided',
    });
    return decision;
  }

  /** Cron may call registered tools exposed by the selected agent's blueprint. */
  #scheduledAuthorization(
    subject: ToolExecutionSubject,
    runAuthority: RunAuthority,
    grants: readonly GrantPattern[] | undefined,
  ): AuthorizationDecision | undefined {
    if (grants === undefined || !samePrincipal(runAuthority.principal, SYSTEM_CRON))
      return undefined;

    if (this.#authorities?.has(subject.authority) !== true) {
      return {
        allowed: false,
        decidedBy: 'system-cron',
        reason: `Authority "${subject.authority}" is not registered.`,
      };
    }

    const matched = this.#authorities.covers(grants, subject.authority);
    if (matched === undefined) {
      return {
        allowed: false,
        decidedBy: 'system-cron',
        reason: `Cron is not granted "${subject.authority}".`,
      };
    }

    return {
      allowed: true,
      decidedBy: 'system-cron',
      matchedGrant: matched,
      reason: 'The builtin cron principal may use tools exposed by the selected agent.',
    };
  }

  async #gateCall(
    call: ToolCallMessage,
    execution: ToolExecution,
    subject: ToolExecutionSubject,
  ): Promise<ToolResponseMessage | undefined> {
    if (this.#gate === undefined) return undefined;

    const runAuthority = this.#authority();
    const request: GateRequest = {
      authority: subject.authority,
      params: subject.params,
      preview: execution.preview,
      risk: execution.risk,
      runAuthority,
      runId: this.#currentRunId(),
      sessionId: this.#sessionId,
      title: execution.title,
      toolName: subject.toolName,
      toolSetId: subject.toolSetId,
      trackId: call.trackId,
    };
    const decision = await this.#gate.evaluate(request, this.#runSignal());
    if (this.#runSignal().aborted) return this.#abortedToolResponse(call);
    if (decision.verdict === 'allow') return undefined;
    if (decision.verdict === 'deny') {
      return this.#noxResponse(
        call,
        'immediate',
        `Tool call denied by policy: ${decision.reason} Do not retry unless the user changes the request.`,
        true,
      );
    }

    // An escalation is a question for the principal who started the run, and for
    // nobody else. A run Nox started on its own has no one to ask, and there is
    // no delegated approval to fall back on, so it ends here.
    if (runAuthority.principal.issuer === SYSTEM_ISSUER) {
      this.#logger?.warn(
        { authority: subject.authority, toolName: subject.toolName },
        'Denied an escalation on a system run: there is no originator to ask.',
      );
      return this.#noxResponse(
        call,
        'immediate',
        `Tool call not executed: ${decision.reason} ` +
          'This run has no human originator, and approval cannot be delegated.',
        true,
      );
    }

    const pending = this.#gate.requestPermission(request, decision, this.#runSignal());
    if (!pending.accepted) {
      return this.#noxResponse(
        call,
        'immediate',
        'Tool call not executed: this principal already has the maximum number of pending ' +
          'permission requests in this session.',
        true,
      );
    }

    this.#emit({ request: pending.request, type: 'permissionRequested' });
    if (this.#participants.isShared) {
      return this.#detachPermission(call, execution, subject, runAuthority, request.runId, pending);
    }

    // A session may become shared while this escalation is already blocking.
    // The second accepted speaker promotes the exact prepared operation to the
    // detached lifecycle instead of waiting behind its owner.
    const waited = await Promise.race<PermissionWait>([
      pending.outcome.then((resolution) => ({ resolution, type: 'resolution' })),
      this.#participants.whenShared.then(() => ({ type: 'shared' })),
    ]);
    if (waited.type === 'shared') {
      return this.#detachPermission(call, execution, subject, runAuthority, request.runId, pending);
    }

    this.#emitPermissionResolved(pending, waited.resolution, request.runId);
    if (waited.resolution.resolution === 'approved') return undefined;

    return this.#noxResponse(
      call,
      'immediate',
      Runner.#permissionFailure(decision.reason, waited.resolution),
      true,
    );
  }

  #detachPermission(
    call: ToolCallMessage,
    execution: ToolExecution,
    subject: ToolExecutionSubject,
    authority: RunAuthority,
    runId: string,
    pending: PendingPermission,
  ): ToolResponseMessage {
    const response = this.#noxResponse(
      call,
      'permissionPending',
      'Permission is pending from the owner of this exact call. Do not retry it; a correlated ' +
        'result will arrive after approval, denial, timeout, or cancellation.',
      false,
    );
    let publish!: () => void;
    const whenPublished = new Promise<void>((resolve) => {
      publish = resolve;
    });
    const operation: PendingOwnedOperation = {
      authority,
      authorityGrants: this.#runAuthorityGrants,
      call,
      execution,
      pendingResponseId: response.messageId,
      publish,
      published: false,
      responseAttachments: new Map(),
      runId,
      state: 'awaitingApproval',
      subject,
      whenPublished,
    };
    this.#pendingOperations.set(response.messageId, operation);

    void this.#resolvePendingOperation(operation, pending).catch((error: unknown) => {
      operation.state = 'settled';
      this.#logger?.error(
        { err: error, requestId: pending.request.requestId, toolName: call.name },
        'Detached permission operation failed.',
      );
      this.#completePendingOperation(
        operation,
        `Permission operation for ${call.name} failed: ${toError(error).message}`,
      );
    });
    return response;
  }

  async #resolvePendingOperation(
    operation: PendingOwnedOperation,
    pending: PendingPermission,
  ): Promise<void> {
    const resolution = await pending.outcome;
    this.#emitPermissionResolved(pending, resolution, operation.runId);
    if (operation.state !== 'awaitingApproval') return;

    if (resolution.resolution !== 'approved') {
      operation.state = 'settled';
      this.#completePendingOperation(
        operation,
        Runner.#permissionFailure(pending.request.reason, resolution),
      );
      return;
    }

    // Claim the only execution transition before any await. Duplicate answers,
    // timeout and stop all lose this transition and can never call run() twice.
    operation.state = 'executing';
    await operation.whenPublished;
    if (!this.#isOperationExecuting(operation)) return;
    if (this.#sessionAborted()) {
      operation.state = 'settled';
      this.#completePendingOperation(
        operation,
        `Tool ${operation.call.name} was not executed: the session stopped before it started.`,
      );
      return;
    }

    const authorization = await this.#decideAuthorization(
      operation.call,
      operation.subject,
      operation.authority,
      operation.runId,
      this.#session.signal,
      operation.authorityGrants,
    );
    if (!this.#isOperationExecuting(operation)) return;
    if (this.#sessionAborted()) {
      operation.state = 'settled';
      this.#completePendingOperation(
        operation,
        `Tool ${operation.call.name} was not executed: the session stopped before it started.`,
      );
      return;
    }
    if (!authorization.allowed) {
      operation.state = 'settled';
      this.#completePendingOperation(
        operation,
        `Tool call no longer authorized: ${authorization.reason}`,
      );
      return;
    }

    try {
      let response: MessageContent[];
      const toolContext = this.#toolContext(
        operation.call,
        operation.subject,
        this.#session.signal,
        operation.runId,
        operation.responseAttachments,
      );
      if (operation.execution.type === 'deferred') {
        const started = await operation.execution.run(toolContext);
        const result = await started.result;
        // The original call is already paired with permissionPending, so a late
        // deferred ack cannot be emitted as an OpenAI `tool` message. Preserve
        // its information by folding it into the one correlated final result.
        response = [...started.ack, ...result];
      } else {
        response = await operation.execution.run(toolContext);
      }

      operation.state = 'settled';
      this.#completePendingOperation(operation, response);
    } catch (error) {
      operation.state = 'settled';
      this.#completePendingOperation(
        operation,
        `Error executing approved tool ${operation.call.name}: ${toError(error).message}`,
      );
    }
  }

  #isOperationExecuting(operation: PendingOwnedOperation): boolean {
    return operation.state === 'executing';
  }

  #sessionAborted(): boolean {
    return this.#session.signal.aborted;
  }

  /**
   * A string is Nox reporting why the approved call never ran; content is what
   * the tool returned. That is the same split the two builders make, kept
   * visible here rather than folded into an `isError` the caller has to get
   * right.
   */
  #completePendingOperation(
    operation: PendingOwnedOperation,
    response: readonly MessageContent[] | string,
  ): void {
    if (operation.state === 'discarded') return;

    const message =
      typeof response === 'string'
        ? this.#noxResponse(operation.call, 'deferredResult', response, true)
        : this.#toolOutputResponse(operation.call, 'deferredResult', response, operation.subject);
    if (!operation.published) {
      operation.completion = message;
      return;
    }

    this.#pendingOperations.delete(operation.pendingResponseId);
    this.#enqueue({
      authority: operation.authority,
      authorityGrants: operation.authorityGrants,
      message,
      ...(operation.responseAttachments.size === 0
        ? {}
        : { responseAttachments: [...operation.responseAttachments.values()] }),
      trigger: 'deferredResult',
    });
  }

  #publishPendingOperation(responseId: string): void {
    const operation = this.#pendingOperations.get(responseId);
    if (operation === undefined || operation.published) return;

    operation.published = true;
    operation.publish();
    const { completion } = operation;
    if (completion === undefined) return;

    this.#pendingOperations.delete(responseId);
    this.#enqueue({
      authority: operation.authority,
      authorityGrants: operation.authorityGrants,
      message: completion,
      ...(operation.responseAttachments.size === 0
        ? {}
        : { responseAttachments: [...operation.responseAttachments.values()] }),
      trigger: 'deferredResult',
    });
  }

  #discardUnpublishedOperations(runId: string): void {
    for (const [responseId, operation] of this.#pendingOperations) {
      if (operation.runId !== runId || operation.published) continue;
      operation.state = 'discarded';
      operation.publish();
      this.#pendingOperations.delete(responseId);
    }
  }

  #emitPermissionResolved(
    pending: PendingPermission,
    resolution: PermissionResolution,
    runId: string,
  ): void {
    this.#emit({
      requestId: pending.request.requestId,
      resolution,
      runId,
      trackId: pending.request.trackId,
      type: 'permissionResolved',
    });
  }

  #emit(event: AgentEvent): void {
    if (!this.#events.isClosed) this.#events.push(event);
  }

  /** The authority of the run in flight. There is never a run without one. */
  #authority(): RunAuthority {
    const authority = this.#runAuthority;
    if (authority === undefined) {
      throw new Error('A tool call was made outside a run, which has no authority.');
    }
    return authority;
  }

  #currentRunId(): string {
    const runId = this.#runId;
    if (runId === undefined) {
      throw new Error('A tool call was made outside a run, which has no run ID.');
    }
    return runId;
  }

  static #permissionFailure(reason: string, resolution: PermissionResolution): string {
    switch (resolution.resolution) {
      case 'aborted':
        return `Tool call not executed: ${reason} The run was interrupted before approval.`;
      case 'denied':
        return `Tool call not executed: ${reason} The user denied permission.`;
      case 'timeout':
        return `Tool call not executed: ${reason} Permission timed out.`;
      case 'approved':
        throw new Error('An approved permission is not a failure.');
    }
  }

  #abortedToolResponse(call: ToolCallMessage): ToolResponseMessage {
    this.#logger?.debug(
      { toolName: call.name },
      'Skipped a tool call whose run was aborted before it could settle.',
    );
    return this.#noxResponse(
      call,
      'immediate',
      `Tool ${call.name} was not executed: the run was aborted before it settled.`,
      true,
    );
  }

  /**
   * Nox speaking about a call rather than reporting its output: an unknown tool,
   * a refused authority, a policy denial, a timeout, an abort, a thrown error,
   * or the receipt for a call still waiting on permission.
   *
   * Always trusted. These are the system's own words, and fencing them as
   * untrusted data would tell the model to disregard the very messages it most
   * needs to act on.
   */
  #noxResponse(
    call: ToolCallMessage,
    execution: ToolResponseExecution,
    message: string,
    isError: boolean,
  ): ToolResponseMessage {
    return this.#response(call, execution, [{ text: message, type: 'text' }], 'trusted', isError);
  }

  /**
   * A response carrying what a tool returned. It reads trust off the execution's
   * own subject rather than off an argument, so tool output cannot be recorded
   * without the verdict the tool declared — and on a routed call that subject is
   * the routed tool's, not `call_tool`'s.
   */
  #toolOutputResponse(
    call: ToolCallMessage,
    execution: ToolResponseExecution,
    response: readonly MessageContent[],
    subject: ToolExecutionSubject,
  ): ToolResponseMessage {
    return this.#response(call, execution, response, subject.trust, false);
  }

  #response(
    call: ToolCallMessage,
    execution: ToolResponseExecution,
    response: readonly MessageContent[],
    trust: ToolOutputTrust,
    isError: boolean,
  ): ToolResponseMessage {
    return {
      createdAt: new Date(),
      execution,
      isError,
      messageId: nanoid(),
      name: call.name,
      response,
      role: 'toolResponse',
      trackId: call.trackId,
      trust,
    };
  }

  /**
   * The result queues like anything else, and wakes the runner if it is idle.
   *
   * It carries the authority of the run that started the operation, so a result
   * landing long after that run ended is not an unattributed one — and if it
   * makes the model ask for another tool, that call is authorized and gated
   * afresh under the same principal.
   */
  #trackDeferred(
    call: ToolCallMessage,
    result: Promise<MessageContent[]>,
    authority: RunAuthority,
    authorityGrants: readonly GrantPattern[] | undefined,
    subject: ToolExecutionSubject,
  ): void {
    void result.then(
      (response) => {
        this.#logger?.debug({ toolName: call.name }, 'Deferred tool result received.');
        this.#enqueue({
          authority,
          authorityGrants,
          message: this.#toolOutputResponse(call, 'deferredResult', response, subject),
          trigger: 'deferredResult',
        });
      },
      (error: unknown) => {
        // Out-of-band: nothing else is watching this promise.
        this.#logger?.error({ err: error, toolName: call.name }, 'Deferred tool failed.');
        this.#enqueue({
          authority,
          authorityGrants,
          message: this.#noxResponse(
            call,
            'deferredResult',
            `Deferred tool ${call.name} failed: ${toError(error).message}`,
            true,
          ),
          trigger: 'deferredResult',
        });
      },
    );
  }
}

export { Runner };

export type { RunnerOptions, RunnerState };
