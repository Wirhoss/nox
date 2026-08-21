import { nanoid } from 'nanoid';

import { prepareTool } from '../tool/tool';

import type { Logger } from '../logger/logger';
import type { ModelConfig } from '../provider/config';
import type { ProviderError } from '../provider/error';
import type { ChatProvider } from '../provider/provider';
import type { Usage } from '../provider/stream';
import type { EventLog } from '../utils/eventLog';
import type { Context } from './context/context';
import type {
  Message,
  MessageContent,
  ToolCallMessage,
  ToolResponseExecution,
  ToolResponseMessage,
  UserMessage,
} from './context/message';
import type { AgentEvent, RunStatus, RunTrigger } from './events';

const DEFAULT_MAX_ITERATIONS = 90;

type RunnerState = 'idle' | 'running' | 'stopped';

interface RunnerOptions {
  logger?: Logger;
  /** `'unlimited'` runs until the model stops asking for tools. At your risk. */
  maxIterations?: 'unlimited' | number;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function resolveMaxIterations(maxIterations: RunnerOptions['maxIterations']): number {
  if (maxIterations === undefined) return DEFAULT_MAX_ITERATIONS;
  if (maxIterations === 'unlimited') return Number.POSITIVE_INFINITY;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new RangeError('maxIterations must be a positive integer or "unlimited".');
  }
  return maxIterations;
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
  readonly #context: Context;
  readonly #events: EventLog<AgentEvent>;
  readonly #logger?: Logger;
  readonly #maxIterations: number;
  readonly #model: ModelConfig;
  readonly #provider: ChatProvider;

  /** Waiting to enter the context: user messages and deferred results alike. */
  readonly #queue: Message[] = [];

  /** Outlives every run, so background work survives `abort()` and `steer()`. */
  readonly #session = new AbortController();

  #run?: AbortController;
  #idle: Promise<void> = Promise.resolve();
  #resolveIdle?: () => void;
  #state: RunnerState = 'idle';

  constructor(
    context: Context,
    events: EventLog<AgentEvent>,
    provider: ChatProvider,
    model: ModelConfig,
    options: RunnerOptions = {},
  ) {
    this.#context = context;
    this.#events = events;
    this.#provider = provider;
    this.#model = model;
    this.#logger = options.logger;
    this.#maxIterations = resolveMaxIterations(options.maxIterations);
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

  /** Queues a message, and wakes the runner if nothing is running. */
  public send(message: UserMessage): void {
    this.#enqueue(message, 'user');
  }

  /** Cuts the current run short and speaks over it. */
  public async steer(message: UserMessage): Promise<void> {
    await this.abort();
    this.#enqueue(message, 'steer');
  }

  /**
   * Ends the session for good: the run in flight is aborted, background work is
   * cancelled and the event log closes. A runner cannot be restarted.
   */
  public async stop(): Promise<void> {
    if (this.#state === 'stopped') return;

    this.#run?.abort();
    await this.#idle;
    this.#state = 'stopped';
    this.#session.abort();
    this.#events.close();
  }

  /** Empties the queue into the context. Never starts anything. */
  #drain(): void {
    for (const message of this.#queue.splice(0)) {
      this.#context.addMessage(message);
    }
  }

  #enqueue(message: Message, trigger: RunTrigger): void {
    // A late result still belongs to the transcript, which is permanent and
    // complete; dropping it to save the trouble would be deleting it.
    if (this.#state === 'stopped') {
      this.#context.addMessage(message);
      return;
    }

    this.#queue.push(message);
    if (this.#state === 'running') return;

    void this.#execute(trigger).catch((error: unknown) => {
      // #execute reports failures as events; nobody may be subscribed, so the
      // log is the backstop rather than an unhandled rejection.
      this.#logger?.error({ err: error }, 'Agent run failed.');
    });
  }

  async #execute(trigger: RunTrigger): Promise<void> {
    // Set before the first await: a second enqueue in this same tick has to see
    // a running runner, or it would start a second run.
    this.#state = 'running';
    this.#run = new AbortController();
    this.#idle = new Promise<void>((resolve) => {
      this.#resolveIdle = resolve;
    });

    const runId = nanoid();
    const startedAt = new Date();
    const usage: Usage = { cacheReadTokens: 0, inputTokens: 0, outputTokens: 0 };

    this.#events.push({
      modelId: this.#model.modelId,
      runId,
      startedAt,
      trigger,
      type: 'runStarted',
    });

    try {
      this.#finish(runId, await this.#runLoop(usage), startedAt, usage);
    } catch (error) {
      const failure = toError(error);
      this.#logger?.error({ err: failure, modelId: this.#model.modelId }, 'Agent run failed.');
      this.#events.push({ error: failure, type: 'error' });
      this.#finish(runId, 'failed', startedAt, usage);
    } finally {
      // An aborted run can leave the queue loaded. Its contents are recorded so
      // nothing is lost, but they do not get to start a run nobody asked for.
      this.#drain();
      this.#run = undefined;
      this.#state = 'idle';
      this.#resolveIdle?.();
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
    const requestTokenEstimate = this.#context.getTokenEstimate();
    const stream = this.#provider.getMessageStream(
      this.#context.getSystemPrompt(),
      [...this.#context.getHistory()],
      Object.values(this.#context.getTools()),
      { model: this.#model, signal: this.#runSignal() },
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
          for (const message of event.messages) this.#context.addMessage(message);
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

  #recordUsage(total: Usage, call: Usage): void {
    total.cacheReadTokens = (total.cacheReadTokens ?? 0) + (call.cacheReadTokens ?? 0);
    total.inputTokens += call.inputTokens;
    total.outputTokens += call.outputTokens;
    this.#events.push({ type: 'usage', usage: call });
  }

  async #runLoop(usage: Usage): Promise<RunStatus> {
    for (let iteration = 0; iteration < this.#maxIterations; iteration++) {
      this.#drain();
      await this.#context.compact();

      const responses = await this.#request(usage);
      for (const response of responses) this.#context.addMessage(response);

      if (this.#runSignal().aborted) return 'aborted';

      if (responses.length === 0) {
        // The model answered instead of asking for another tool, so it has
        // consumed the results and this run's mechanical traffic is settled.
        // Folding it here is deterministic and lossless — the originals stay in
        // the transcript — and a fold that reclaims too little to pay for the
        // head rewrite is rejected inside the context.
        await this.#context.fold();
        if (this.#queue.length === 0) return 'completed';
      }
    }

    // Not a failure, but the reply is probably cut off mid-thought.
    this.#logger?.warn(
      { maxIterations: this.#maxIterations },
      'Agent run hit the tool iteration ceiling.',
    );
    return 'maxIterations';
  }

  #runSignal(): AbortSignal {
    return this.#run?.signal ?? this.#session.signal;
  }

  async #runTool(call: ToolCallMessage): Promise<ToolResponseMessage> {
    const tool = this.#context.getTools()[call.name];
    if (tool === undefined) {
      // The model asked for something it was never given: a wiring problem.
      this.#logger?.warn({ toolName: call.name }, 'Tool call requested an unknown tool.');
      return this.#toolResponse(call, 'immediate', `Tool ${call.name} not found.`, true);
    }

    const startedAt = Date.now();
    try {
      const execution = prepareTool(tool, call.arguments);

      if (execution.type === 'deferred') {
        const { ack, result } = await execution.run({ abortSignal: this.#session.signal });
        this.#trackDeferred(call, result);
        this.#logger?.debug(
          { durationMs: Date.now() - startedAt, toolName: call.name },
          'Deferred tool acknowledged.',
        );
        return this.#toolResponse(call, 'deferredAck', ack, false);
      }

      const response = await execution.run({ abortSignal: this.#runSignal() });
      this.#logger?.debug(
        { durationMs: Date.now() - startedAt, toolName: call.name },
        'Tool call completed.',
      );
      return this.#toolResponse(call, 'immediate', response, false);
    } catch (error) {
      // Reported to the model as tool output, and to the operator as a log: an
      // error only the model can see is an error nobody can debug.
      this.#logger?.error(
        { durationMs: Date.now() - startedAt, err: error, toolName: call.name },
        'Tool call failed.',
      );
      return this.#toolResponse(
        call,
        'immediate',
        `Error executing tool ${call.name}: ${toError(error).message}`,
        true,
      );
    }
  }

  #toolResponse(
    call: ToolCallMessage,
    execution: ToolResponseExecution,
    response: readonly MessageContent[] | string,
    isError: boolean,
  ): ToolResponseMessage {
    return {
      createdAt: new Date(),
      execution,
      isError,
      messageId: nanoid(),
      name: call.name,
      response: typeof response === 'string' ? [{ text: response, type: 'text' }] : response,
      role: 'toolResponse',
      trackId: call.trackId,
    };
  }

  /** The result queues like anything else, and wakes the runner if it is idle. */
  #trackDeferred(call: ToolCallMessage, result: Promise<MessageContent[]>): void {
    void result.then(
      (response) => {
        this.#logger?.debug({ toolName: call.name }, 'Deferred tool result received.');
        this.#enqueue(
          this.#toolResponse(call, 'deferredResult', response, false),
          'deferredResult',
        );
      },
      (error: unknown) => {
        // Out-of-band: nothing else is watching this promise.
        this.#logger?.error({ err: error, toolName: call.name }, 'Deferred tool failed.');
        this.#enqueue(
          this.#toolResponse(
            call,
            'deferredResult',
            `Deferred tool ${call.name} failed: ${toError(error).message}`,
            true,
          ),
          'deferredResult',
        );
      },
    );
  }
}

export { DEFAULT_MAX_ITERATIONS, Runner };

export type { RunnerOptions, RunnerState };
