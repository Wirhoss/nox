import { nanoid } from 'nanoid';

import { createLogger } from '../logger';
import { EventLog } from '../utils';

import type { EscalationHub, EscalationResolution, ToolGate } from '../gate';
import type {
  Message,
  MessageContent,
  ModelConfig,
  Provider,
  ProviderStream,
  ToolCallMessage,
  ToolResponseMessage,
  Usage,
  UserMessage,
} from '../provider';
import type { ToolContext } from '../tool';
import type { Context } from './context';
import type { Logger } from 'pino';

enum RunnerState {
  Idle,
  Running,
  Stopped
}

enum StopReason {
  Completed,
  Aborted,
  MaxIterations,
}

type AgentStreamEvent =
  | { type: 'assistantTextFragment', text: string }
  | { type: 'assistantReasoningFragment', text: string }
  | { type: 'message', message: Message }
  | { type: 'permissionRequest', requestId: string, toolName: string, toolArguments: Record<string, unknown>, reason: string }
  | { type: 'permissionResolved', requestId: string, resolution: EscalationResolution }
  | { type: 'runStarted'; runId: string; modelId: string; startedAt: string }
  | {
    type: 'runCompleted';
    runId: string;
    status: 'completed' | 'aborted' | 'maxIterations' | 'failed';
    durationMs: number;
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  }
  | { type: 'error'; error: Error };

interface RunnerOptions {
  maxAttempts?: number;
  maxIterations: number;
  retryDelayMs?: number;
  gate?: ToolGate;
  escalation?: EscalationHub;
  escalationTimeoutMs?: number;
  /** Correlates every log line this runner emits with its session. */
  sessionId?: string;
}

const DEFAULT_ESCALATION_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const logger = createLogger('agent');

class RetryableProviderError extends Error {
  public readonly providerError: Error;

  constructor(providerError: Error) {
    super(providerError.message, { cause: providerError });
    this.name = 'RetryableProviderError';
    this.providerError = providerError;
  }
}

class Runner {
  private eventLog: EventLog<AgentStreamEvent>;
  private context: Context;

  private maxIterations: number;
  private maxAttempts: number;
  private retryDelayMs: number;
  private gate?: ToolGate;
  private escalation?: EscalationHub;
  private escalationTimeoutMs: number;

  private provider: Provider;
  private model: ModelConfig;

  private abortController?: AbortController;
  private state: RunnerState = RunnerState.Idle;
  private idlePromise: Promise<void> = Promise.resolve();
  private idleResolve: (() => void) | undefined;

  private pendingInjections: ToolResponseMessage[] = [];

  /** Session-scoped logger; `activeLog` narrows it to the current run. */
  private readonly log: Logger;
  private activeLog: Logger;

  constructor(context: Context, eventLog: EventLog<AgentStreamEvent>, provider: Provider, model: ModelConfig, options: RunnerOptions) {
    this.context = context;
    this.eventLog = eventLog;
    this.provider = provider;
    this.model = model;
    this.log = options.sessionId ? logger.child({ sessionId: options.sessionId }) : logger;
    this.activeLog = this.log;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.maxIterations = options.maxIterations;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.gate = options.gate;
    this.escalation = options.escalation;
    this.escalationTimeoutMs = options.escalationTimeoutMs ?? DEFAULT_ESCALATION_TIMEOUT_MS;
  }

  private getMessageStream(): ProviderStream {
    const stream: ProviderStream = this.provider.getMessageStream(
      this.context.systemPrompt,
      this.context.messageHistory,
      Object.values(this.context.tools),
      { model: this.model, signal: this.abortController?.signal }
    );
    return stream;
  }

  private toolContext(): ToolContext {
    return {
      abortSignal: this.abortController?.signal ?? new AbortController().signal,
    };
  }

  private handleText(text: string): void {
    this.eventLog.push({
      type: 'assistantTextFragment',
      text: text,
    });
  }

  private handleReasoning(text: string): void {
    this.eventLog.push({
      type: 'assistantReasoningFragment',
      text,
    });
  }

  private async checkPermission(toolCall: ToolCallMessage, toolResponse: ToolResponseMessage): Promise<boolean> {
    const verdict = this.gate?.evaluate(toolCall) ?? { verdict: 'pass' as const };
    if (verdict.verdict === 'pass') {
      return true;
    }
    // Everything past this point is a policy decision about a tool call, so it
    // is logged unconditionally: this is the audit trail for the gate.
    if (verdict.verdict === 'deny') {
      this.activeLog.warn(
        { reason: verdict.reason, toolName: toolCall.name },
        'Tool call denied by gate policy.',
      );
      toolResponse.response.push({
        type: 'text',
        text: `Tool call denied by policy: ${verdict.reason} This decision is final; do not retry this call.`,
      });
      toolResponse.isError = true;
      return false;
    }

    if (!this.escalation) {
      this.activeLog.warn(
        { reason: verdict.reason, toolName: toolCall.name },
        'Tool call requires approval but no escalation hub is attached; refusing it.',
      );
      toolResponse.response.push({
        type: 'text',
        text: `Tool call not executed: ${verdict.reason} User approval is required but unavailable; do not retry this call.`,
      });
      toolResponse.isError = true;
      return false;
    }

    const requestId = nanoid();
    this.activeLog.info(
      { reason: verdict.reason, requestId, toolName: toolCall.name },
      'Tool call escalated for user approval.',
    );
    this.eventLog.push({
      type: 'permissionRequest',
      requestId,
      toolName: toolCall.name,
      toolArguments: toolCall.arguments,
      reason: verdict.reason,
    });
    const resolution = await this.escalation.wait(requestId, this.escalationTimeoutMs, this.abortController?.signal, {
      toolName: toolCall.name,
      toolArguments: toolCall.arguments,
      reason: verdict.reason,
    });
    this.eventLog.push({ type: 'permissionResolved', requestId, resolution });
    this.activeLog.info(
      { requestId, resolution, toolName: toolCall.name },
      'Tool call escalation resolved.',
    );

    if (resolution === 'approved') {
      return true;
    }
    const explanation: Record<Exclude<EscalationResolution, 'approved'>, string> = {
      denied: 'The user denied permission.',
      timeout: 'The permission request timed out without an answer.',
      aborted: 'The run was interrupted before permission was granted.',
    };
    toolResponse.response.push({
      type: 'text',
      text: `Tool call not executed: ${verdict.reason} ${explanation[resolution]} Do not retry this call unless the user asks for it.`,
    });
    toolResponse.isError = true;
    return false;
  }

  private async handleToolCall(toolCall: ToolCallMessage): Promise<ToolResponseMessage> {
    this.eventLog.push({
      type: 'message',
      message: toolCall,
    });
    const toolResponse: ToolResponseMessage = {
      role: 'toolResponse',
      name: toolCall.name,
      trackId: toolCall.trackId,
      execution: 'immediate',
      response: [],
    };
    const startedAt = Date.now();
    this.activeLog.debug(
      { toolArguments: toolCall.arguments, toolName: toolCall.name },
      'Tool call started.',
    );
    try {
      const tool = this.context.tools[toolCall.name];
      if (!tool) {
        // The model asked for a tool it was never given; that points at a
        // blueprint or router problem, not at the model.
        this.activeLog.warn({ toolName: toolCall.name }, 'Tool call requested an unknown tool.');
        toolResponse.response.push({
          type: 'text',
          text: `Tool ${toolCall.name} not found.`,
        });
        toolResponse.isError = true;
      } else if (await this.checkPermission(toolCall, toolResponse)) {
        const parsedArguments = tool.parameters.parse(toolCall.arguments);
        if (tool.type === 'deferred') {
          const { ack, result } = await tool.start(parsedArguments, this.toolContext());
          toolResponse.execution = 'deferredAck';
          toolResponse.response = [{ type: 'text', text: ack }];
          toolResponse.isError = false;
          this.trackDeferredResult(toolCall, result);
          this.activeLog.debug(
            { durationMs: Date.now() - startedAt, toolName: toolCall.name },
            'Deferred tool acknowledged.',
          );
        } else {
          const response: MessageContent[] = await tool.call(parsedArguments, this.toolContext());
          toolResponse.response = response ?? [];
          toolResponse.isError = false;
          this.activeLog.debug(
            { durationMs: Date.now() - startedAt, toolName: toolCall.name },
            'Tool call completed.',
          );
        }
      }
    } catch (error) {
      // The failure is reported to the model as tool output, which would
      // otherwise make it invisible to anyone operating the app.
      this.activeLog.error(
        { durationMs: Date.now() - startedAt, err: error, toolArguments: toolCall.arguments, toolName: toolCall.name },
        'Tool call failed.',
      );
      toolResponse.response.push({
        type: 'text',
        text: `Error executing tool ${toolCall.name}: ${(error as Error).message}`,
      });
      toolResponse.isError = true;
    }
    this.eventLog.push({
      type: 'message',
      message: toolResponse,
    });
    return toolResponse;
  }

  private trackDeferredResult(toolCall: ToolCallMessage, result: Promise<MessageContent[]>): void {
    const log = this.activeLog;
    result.then(
      (content) => {
        log.debug({ toolName: toolCall.name }, 'Deferred tool result received.');
        this.injectDeferredResult(toolCall, content ?? [], false);
      },
      (error) => {
        // Out-of-band failure: nothing else observes this rejection.
        log.error({ err: error, toolName: toolCall.name }, 'Deferred tool failed.');
        this.injectDeferredResult(
          toolCall,
          [{ type: 'text', text: `Deferred tool ${toolCall.name} failed: ${(error as Error).message}` }],
          true,
        );
      },
    );
  }

  /**
   * Mid-run results ride the loop that is already paying for a model call;
   * only an idle runner needs a fresh entry (resume). After stop the session
   * is gone and the result is dropped.
   */
  private injectDeferredResult(toolCall: ToolCallMessage, response: MessageContent[], isError: boolean): void {
    if (this.state === RunnerState.Stopped) {
      return;
    }
    const message: ToolResponseMessage = {
      role: 'toolResponse',
      name: toolCall.name,
      trackId: toolCall.trackId,
      execution: 'deferredResult',
      response,
      isError,
    };
    if (this.state === RunnerState.Running) {
      this.pendingInjections.push(message);
      return;
    }
    this.commitInjection(message);
    // Fire-and-forget wake-up. The event log carries the failure to whoever is
    // subscribed, but nobody may be, so it is logged here too.
    void this.resume().catch((error: unknown) => {
      this.log.error({ err: error, toolName: toolCall.name }, 'Resume after a deferred tool result failed.');
    });
  }

  private commitInjection(message: ToolResponseMessage): void {
    this.eventLog.push({ type: 'message', message });
    this.context.addMessage(message);
  }

  private drainInjections(): void {
    for (const message of this.pendingInjections.splice(0)) {
      this.commitInjection(message);
    }
  }

  private async waitBeforeRetry(attempt: number): Promise<void> {
    const delayMs = this.retryDelayMs * (2 ** (attempt - 1));
    if (delayMs === 0) return;

    await new Promise<void>((resolve, reject) => {
      const signal = this.abortController?.signal;
      const timeoutId = setTimeout((): void => {
        signal?.removeEventListener('abort', abort);
        resolve();
      }, delayMs);
      function abort(): void {
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', abort);
        reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      }

      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private async runProviderAttempt(): Promise<Promise<ToolResponseMessage>[]> {
    const toolCalls: Promise<ToolResponseMessage>[] = [];
    let receivedOutput = false;

    try {
      const stream = this.getMessageStream();
      let streamError: Error | undefined;

      for await (const event of stream) {
        if (event.type === 'textFragment') {
          receivedOutput = true;
          this.handleText(event.text);
        } else if (event.type === 'reasoningFragment') {
          receivedOutput = true;
          this.handleReasoning(event.text);
        } else if (event.type === 'toolCall') {
          receivedOutput = true;
          toolCalls.push(this.handleToolCall(event.toolCall));
        } else if (event.type === 'end') {
          await this.commitAssistantMessage(event.messages, event.usage);
        } else if (event.type === 'error') {
          streamError = event.error;
        }
      }

      if (streamError) throw streamError;
      return toolCalls;
    } catch (error) {
      const providerError = error instanceof Error ? error : new Error(String(error));
      if (receivedOutput || this.abortController?.signal.aborted) throw providerError;
      throw new RetryableProviderError(providerError);
    }
  }

  private async runProviderWithRetries(): Promise<Promise<ToolResponseMessage>[]> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await this.runProviderAttempt();
      } catch (error) {
        const retryableError = error instanceof RetryableProviderError
          ? error.providerError
          : error;
        if (
          !(error instanceof RetryableProviderError)
          || attempt === this.maxAttempts
          || this.abortController?.signal.aborted
        ) {
          throw retryableError;
        }
        this.activeLog.warn({
          attempt,
          err: retryableError,
          maxAttempts: this.maxAttempts,
          modelId: this.model.modelId,
        }, 'Provider stream failed before producing output; retrying.');
        await this.waitBeforeRetry(attempt);
      }
    }
    throw new Error('Provider retry loop exhausted unexpectedly.');
  }

  private async commitAssistantMessage(messages: Message[], usage?: Usage): Promise<Message[]> {
    for (const message of messages) {
      if (message.role !== 'toolCall') {
        this.eventLog.push({
          type: 'message',
          message: message,
        });
      }
      this.context.addMessage(message);
    }
    if (usage) {
      this.context.inputTokens += usage.inputTokens;
      this.context.outputTokens += usage.outputTokens;
      this.context.cacheReadTokens += usage.cacheReadTokens ?? 0;
    }
    return messages;
  }

  private async runLoop(): Promise<StopReason> {
    for (let i = 0; i < this.maxIterations; i++) {
      this.drainInjections();
      const toolCalls = await this.runProviderWithRetries();
      const toolResponses = await Promise.all(toolCalls);

      for (const toolResponse of toolResponses) {
        this.context.addMessage(toolResponse);
      }
      if (this.abortController?.signal.aborted) return StopReason.Aborted;
      if (toolResponses.length === 0 && this.pendingInjections.length === 0) return StopReason.Completed;
    }
    // Not an error, but the run was cut short: the answer is likely truncated.
    this.activeLog.warn(
      { maxIterations: this.maxIterations },
      'Agent run hit the tool iteration ceiling.',
    );
    this.context.addMessage({
      role: 'user',
      content: [{ type: 'text', text: 'Maximum tool iterations reached.' }],
    });
    return StopReason.MaxIterations;
  }

  public get isRunning(): boolean {
    return this.state === RunnerState.Running;
  }

  /** Resolves when the current run finishes; already resolved while idle. */
  public get idle(): Promise<void> {
    return this.idlePromise;
  }

  public async run(userMessage: UserMessage): Promise<StopReason> {
    return this.execute(userMessage);
  }

  /** Re-enters the loop without a new user message (deferred result wake-up). */
  public async resume(): Promise<StopReason> {
    return this.execute();
  }

  private async execute(userMessage?: UserMessage): Promise<StopReason> {
    if (this.state === RunnerState.Running) {
      throw new Error('Agent is already running');
    } else if (this.state === RunnerState.Stopped) {
      throw new Error('Agent has been stopped and cannot be restarted');
    }

    this.idlePromise = new Promise(resolve => {
        this.idleResolve = resolve;
    });

    this.state = RunnerState.Running;
    this.abortController = new AbortController();

    const runId = nanoid();
    this.activeLog = this.log.child({ runId });
    const startedAt = Date.now();
    const usageAtStart = {
      inputTokens: this.context.inputTokens,
      outputTokens: this.context.outputTokens,
      cacheReadTokens: this.context.cacheReadTokens,
    };
    this.eventLog.push({
      type: 'runStarted',
      runId,
      modelId: this.model.modelId,
      startedAt: new Date(startedAt).toISOString(),
    });
    this.activeLog.info(
      { modelId: this.model.modelId, resumed: userMessage === undefined },
      'Agent run started.',
    );
    const completeRun = (
      status: Extract<AgentStreamEvent, { type: 'runCompleted' }>['status'],
    ): void => {
      const durationMs = Date.now() - startedAt;
      const usage = {
        inputTokens: this.context.inputTokens - usageAtStart.inputTokens,
        outputTokens: this.context.outputTokens - usageAtStart.outputTokens,
        cacheReadTokens: this.context.cacheReadTokens - usageAtStart.cacheReadTokens,
      };
      this.eventLog.push({
        type: 'runCompleted',
        runId,
        status,
        durationMs,
        usage,
      });
      // Token counts are the app's cost signal, so they ride the run summary.
      this.activeLog.info(
        { durationMs, modelId: this.model.modelId, status, usage },
        'Agent run finished.',
      );
    };

    if (userMessage) {
      this.context.addMessage(userMessage);
      this.eventLog.push({ type: 'message', message: userMessage });
    }

    try {
      const reason = await this.runLoop();
      completeRun(reason === StopReason.Completed
        ? 'completed'
        : reason === StopReason.Aborted
          ? 'aborted'
          : 'maxIterations');
      return reason;
    } catch (error) {
      if (this.abortController?.signal.aborted) {
        completeRun('aborted');
        return StopReason.Aborted;
      }
      const parsedError = error instanceof Error ? error : new Error(String(error));
      this.activeLog.error({ err: parsedError, modelId: this.model.modelId }, 'Agent run failed.');
      this.eventLog.push({
        type: 'error',
        error: parsedError,
      });
      completeRun('failed');
      throw new Error(`Error in agent run loop: ${parsedError.message}`, { cause: error });
    } finally {
      this.state = RunnerState.Idle;
      this.abortController = undefined;
      this.activeLog = this.log;
      this.idleResolve?.();
    }
  }

  /** Aborts the in-flight run without queuing anything new; false while idle. */
  public async abort(): Promise<boolean> {
    if (this.state !== RunnerState.Running) {
      return false;
    }
    this.abortController?.abort();
    await this.idlePromise;
    return true;
  }

  public async steer(userMessage: UserMessage): Promise<StopReason> {
    if (this.state !== RunnerState.Running) {
      throw new Error('Cannot steer agent when it is not running.');
    }
    this.abortController?.abort();
    await this.idlePromise;
    return await this.run(userMessage);
  }

  public async stop(): Promise<void> {
    if (this.state === RunnerState.Stopped) {
      return;
    }
    this.abortController?.abort();
    await this.idlePromise;
    this.eventLog.close();
    this.state = RunnerState.Stopped;
  }
}

export {
  Runner,
  StopReason
};

export type {
  AgentStreamEvent,
  RunnerOptions,
};
