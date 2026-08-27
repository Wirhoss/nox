import { nanoid } from 'nanoid';
import { z } from 'zod';

import { type ArtifactOutputPublisher, type ArtifactRef, artifactRefSchema } from './artifacts.js';
import {
  CONTENT_MODALITIES,
  type ContentModality,
  type Message,
  type MessageContent,
  type ToolCallMessage,
} from './content.js';
import {
  httpUrlSchema,
  runtimeSecretSchema,
  type SecretHandle,
  secretRefSchema,
} from './schemas.js';

import type { Tool } from './tools.js';

const samplingParametersConfigSchema = z.object({
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  seed: z.number().int().optional(),
  stop: z.array(z.string()).optional(),
  temperature: z.number().min(0).max(1).optional(),
  topK: z.number().int().positive().optional(),
  topP: z.number().min(0).max(1).optional(),
});

const requiredChatModalities = (direction: 'input' | 'output') =>
  z
    .array(z.enum(CONTENT_MODALITIES))
    .min(1)
    .refine((modalities) => modalities.includes('text'), {
      message: `Text ${direction} is required by the chat model interface.`,
    });
const modelInputModalitiesSchema = requiredChatModalities('input');
const modelOutputModalitiesSchema = requiredChatModalities('output');
const modelBaseConfigSchema = samplingParametersConfigSchema.extend({
  inputModalities: modelInputModalitiesSchema.default((): ContentModality[] => ['text']),
  modelId: z.string(),
  outputModalities: modelOutputModalitiesSchema.default((): ContentModality[] => ['text']),
});
const chatModelConfigSchema = modelBaseConfigSchema.extend({
  contextWindow: z.number().int().positive().optional(),
});
const modelConfigSchema = chatModelConfigSchema;
type ModelConfig = z.infer<typeof modelConfigSchema>;

function modelInputModalities(model: ModelConfig): readonly ContentModality[] {
  return model.inputModalities;
}
function modelAcceptsInput(model: ModelConfig, modality: ContentModality): boolean {
  return modelInputModalities(model).includes(modality);
}
function modelProducesOutput(model: ModelConfig, modality: ContentModality): boolean {
  return model.outputModalities.includes(modality);
}

const providerConfigShape = {
  baseUrl: httpUrlSchema('The HTTP(S) base URL of the provider endpoint.'),
  maxRetries: z.number().int().nonnegative().default(2),
  maxRetryDelayMs: z.number().nonnegative().default(30_000),
  modelConfigs: z.array(modelConfigSchema).optional(),
  retryDelayMs: z.number().nonnegative().default(500),
  timeoutMs: z.number().positive().optional(),
};
const providerBaseConfigSchema = z.object({
  ...providerConfigShape,
  apiKey: secretRefSchema.optional(),
});
const providerRuntimeConfigSchema = z.object({
  ...providerConfigShape,
  // Structural by design: a host capability must survive package/module boundaries.
  apiKey: runtimeSecretSchema.optional(),
});

type ProviderBaseConfig = z.infer<typeof providerBaseConfigSchema>;
type ProviderBaseConfigInput = z.input<typeof providerBaseConfigSchema>;
type ProviderRuntimeConfigInput = z.input<typeof providerRuntimeConfigSchema>;

const textGenerateOptionsSchema = samplingParametersConfigSchema.extend({
  metadata: z.record(z.string(), z.unknown()).optional(),
  model: modelConfigSchema.optional(),
  requestId: z.string().optional(),
  signal: z.instanceof(AbortSignal).optional(),
  timeZone: z.string().min(1).optional(),
});

interface TextGenerateOptions extends z.infer<typeof textGenerateOptionsSchema> {
  readonly artifactOutput?: ArtifactOutputPublisher;
}

type ProviderErrorCode =
  | 'authentication'
  | 'connection'
  | 'context_limit'
  | 'invalid_request'
  | 'provider_error'
  | 'rate_limit'
  | 'usage_limit';

interface ProviderErrorOptions {
  cause?: unknown;
  provider?: string;
  providerCode?: string;
  status?: number;
}

class ProviderError extends Error {
  public readonly code: ProviderErrorCode;
  public readonly provider?: string;
  public readonly providerCode?: string;
  public readonly status?: number;

  constructor(code: ProviderErrorCode, message: string, options: ProviderErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'ProviderError';
    this.code = code;
    this.provider = options.provider;
    this.providerCode = options.providerCode;
    this.status = options.status;
  }
}

function isProviderError(error: unknown): error is ProviderError {
  return (
    error instanceof ProviderError ||
    (error instanceof Error &&
      error.name === 'ProviderError' &&
      typeof Reflect.get(error, 'code') === 'string')
  );
}

function toProviderError(
  error: unknown,
  fallbackMessage = 'Provider request failed',
): ProviderError {
  if (error instanceof ProviderError) return error;
  let message = fallbackMessage;
  if (error instanceof Error) message = error.message;
  else if (typeof error === 'string' && error.length > 0) message = error;
  return new ProviderError('provider_error', message, { cause: error });
}

interface Usage {
  cacheReadTokens?: number;
  inputTokens: number;
  outputTokens: number;
}

type ToolCallDraft = Omit<ToolCallMessage, 'createdAt' | 'messageId'>;
type ProviderSourceEvent =
  | { type: 'artifact'; artifact: ArtifactRef }
  | { type: 'end'; usage?: Usage }
  | { type: 'error'; error: ProviderError }
  | { type: 'reasoningFragment'; text: string }
  | { type: 'retry'; attempt: number; delayMs: number; error: ProviderError; resetOutput: true }
  | { type: 'textFragment'; text: string }
  | { type: 'toolCall'; toolCall: ToolCallDraft };
type ProviderStreamEvent =
  | { type: 'end'; aborted: boolean; messages: Message[]; usage?: Usage }
  | { type: 'error'; error: ProviderError }
  | { type: 'reasoningFragment'; text: string }
  | { type: 'retry'; attempt: number; delayMs: number; error: ProviderError; resetOutput: true }
  | { type: 'textFragment'; text: string }
  | { type: 'toolCall'; toolCall: ToolCallMessage };

enum StreamStatus {
  OPEN,
  ABORTED,
  FAILED,
  COMPLETED,
}

class ProviderStream {
  readonly #abortSignal: AbortSignal;
  readonly #completed: Promise<Message[]>;
  readonly #queue: ProviderStreamEvent[] = [];
  readonly #source: AsyncIterable<ProviderSourceEvent>;
  readonly #waiting: ((event: null | ProviderStreamEvent) => void)[] = [];
  #lastStampMs = 0;
  #reject!: (error: ProviderError) => void;
  #resolve!: (messages: Message[]) => void;
  #status = StreamStatus.OPEN;

  constructor(source: AsyncIterable<ProviderSourceEvent>, abortSignal: AbortSignal) {
    this.#source = source;
    this.#abortSignal = abortSignal;
    this.#completed = new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    this.#completed.catch(() => undefined);
    void this.#pump();
  }

  public get completed(): Promise<Message[]> {
    return this.#completed;
  }
  public get status(): StreamStatus {
    return this.#status;
  }

  public async *[Symbol.asyncIterator](): AsyncGenerator<ProviderStreamEvent> {
    for (;;) {
      const queued = this.#queue.shift();
      if (queued !== undefined) {
        yield queued;
        continue;
      }
      if (this.#status !== StreamStatus.OPEN) return;
      const event = await new Promise<null | ProviderStreamEvent>((resolve) => {
        this.#waiting.push(resolve);
      });
      if (event === null) return;
      yield event;
    }
  }

  async #pump(): Promise<void> {
    const messages: Message[] = [];
    const iterator = this.#source[Symbol.asyncIterator]();
    const assistantContent: MessageContent[] = [];
    let assistantStartedAt: number | undefined;
    let reasoning = '';
    let reasoningStartedAt: number | undefined;
    let text = '';
    let textStartedAt: number | undefined;
    let assistantMaterialized = false;

    const flushReasoning = (): void => {
      if (reasoning.length === 0) return;
      messages.push({
        content: [{ text: reasoning, type: 'text' }],
        createdAt: this.#stamp(reasoningStartedAt),
        messageId: nanoid(),
        role: 'reasoning',
      });
      reasoning = '';
      reasoningStartedAt = undefined;
    };
    const flushText = (): void => {
      if (text.length === 0) return;
      assistantStartedAt ??= textStartedAt;
      assistantContent.push({ text, type: 'text' });
      text = '';
      textStartedAt = undefined;
    };
    const flush = (): void => {
      flushReasoning();
      flushText();
      if (assistantContent.length === 0) return;
      messages.push({
        content: assistantContent.splice(0),
        createdAt: this.#stamp(assistantStartedAt),
        messageId: nanoid(),
        role: 'assistant',
      });
      assistantMaterialized = true;
      assistantStartedAt = undefined;
    };

    let onAbort: (() => void) | undefined;
    const abort = new Promise<StreamStatus.ABORTED>((resolve) => {
      if (this.#abortSignal.aborted) resolve(StreamStatus.ABORTED);
      onAbort = () => {
        resolve(StreamStatus.ABORTED);
      };
      this.#abortSignal.addEventListener('abort', onAbort, { once: true });
    });

    try {
      for (;;) {
        const result = await Promise.race([iterator.next(), abort]);
        if (result === StreamStatus.ABORTED) {
          void iterator.return?.().catch(() => undefined);
          flush();
          this.#finish(messages, true);
          return;
        }
        if (result.done === true) {
          this.#fail(new Error('Provider stream ended without an end event'));
          return;
        }
        const event = result.value;
        switch (event.type) {
          case 'artifact': {
            flushReasoning();
            flushText();
            assistantStartedAt ??= Date.now();
            assistantContent.push({
              artifact: artifactRefSchema.parse(event.artifact),
              type: 'artifact',
            });
            break;
          }
          case 'end': {
            await iterator.return?.();
            flush();
            this.#finish(messages, false, event.usage);
            return;
          }
          case 'error': {
            this.#fail(event.error);
            return;
          }
          case 'reasoningFragment': {
            reasoningStartedAt ??= Date.now();
            reasoning += event.text;
            this.#push(event);
            break;
          }
          case 'retry': {
            assistantContent.length = 0;
            assistantStartedAt = undefined;
            reasoning = '';
            reasoningStartedAt = undefined;
            text = '';
            textStartedAt = undefined;
            assistantMaterialized = false;
            messages.length = 0;
            this.#push(event);
            break;
          }
          case 'textFragment': {
            textStartedAt ??= Date.now();
            text += event.text;
            this.#push(event);
            break;
          }
          case 'toolCall': {
            flush();
            if (!assistantMaterialized) {
              messages.push({
                content: [],
                createdAt: this.#stamp(),
                messageId: nanoid(),
                role: 'assistant',
              });
              assistantMaterialized = true;
            }
            const toolCall: ToolCallMessage = {
              ...event.toolCall,
              createdAt: this.#stamp(),
              messageId: nanoid(),
            };
            messages.push(toolCall);
            this.#push({ toolCall, type: 'toolCall' });
            break;
          }
        }
      }
    } catch (error) {
      if (
        this.#abortSignal.aborted ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) {
        flush();
        this.#finish(messages, true);
      } else {
        this.#fail(error);
      }
    } finally {
      if (onAbort !== undefined) this.#abortSignal.removeEventListener('abort', onAbort);
    }
  }

  #fail(error: unknown): void {
    const providerError = toProviderError(error);
    this.#push({ error: providerError, type: 'error' });
    this.#settle(StreamStatus.FAILED, () => {
      this.#reject(providerError);
    });
  }
  #finish(messages: Message[], aborted: boolean, usage?: Usage): void {
    this.#push({ aborted, messages, type: 'end', usage });
    this.#settle(aborted ? StreamStatus.ABORTED : StreamStatus.COMPLETED, () => {
      this.#resolve(messages);
    });
  }
  #push(event: ProviderStreamEvent): void {
    if (this.#status !== StreamStatus.OPEN) return;
    const waiter = this.#waiting.shift();
    if (waiter === undefined) this.#queue.push(event);
    else waiter(event);
  }
  #settle(status: StreamStatus, action: () => void): void {
    if (this.#status !== StreamStatus.OPEN) return;
    this.#status = status;
    action();
    for (const waiter of this.#waiting.splice(0)) waiter(null);
  }
  #stamp(at?: number): Date {
    this.#lastStampMs = Math.max(at ?? Date.now(), this.#lastStampMs + 1);
    return new Date(this.#lastStampMs);
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new RangeError(
    result.error.issues
      .map((issue) => {
        const path = issue.path.map(String).join('.');
        return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
      })
      .join('; '),
  );
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  if (delayMs === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeoutRef: { current?: ReturnType<typeof setTimeout> } = {};
    const onAbort = (): void => {
      if (timeoutRef.current !== undefined) clearTimeout(timeoutRef.current);
      reject(abortReason(signal));
    };
    timeoutRef.current = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

abstract class BaseProvider {
  static readonly configSchema = providerBaseConfigSchema;
  protected apiKey?: SecretHandle;
  protected baseUrl: string;
  protected timeoutMs?: number;
  protected modelConfigs: Record<string, ModelConfig> = {};
  protected readonly maxRetries: number;
  protected readonly maxRetryDelayMs: number;
  protected readonly retryDelayMs: number;

  constructor(input: ProviderRuntimeConfigInput) {
    const config = parseOrThrow(providerRuntimeConfigSchema, input);
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.maxRetries = config.maxRetries;
    this.maxRetryDelayMs = config.maxRetryDelayMs;
    this.retryDelayMs = config.retryDelayMs;
    this.timeoutMs = config.timeoutMs;
    for (const model of config.modelConfigs ?? []) this.addModelConfig(model);
  }

  public get modelCount(): number {
    return Object.keys(this.modelConfigs).length;
  }
  public abstract fetchModelIds(): Promise<string[]>;
  public addModelConfig(model: ModelConfig): void {
    if (this.modelConfigs[model.modelId] !== undefined) {
      throw new Error(`Model config for modelId ${model.modelId} already exists.`);
    }
    this.modelConfigs[model.modelId] = model;
  }
  public getModelConfig(modelId: string): ModelConfig | undefined {
    return this.modelConfigs[modelId];
  }
  public listModelConfigs(): ModelConfig[] {
    return Object.values(this.modelConfigs);
  }
}

abstract class ChatProvider extends BaseProvider {
  public getMessageStream(
    systemPrompt: string,
    messageHistory: Message[],
    tools: Tool[],
    options?: TextGenerateOptions,
  ): ProviderStream {
    const signal = options?.signal ?? new AbortController().signal;
    return new ProviderStream(
      this.#streamWithRetries(systemPrompt, messageHistory, tools, options, signal),
      signal,
    );
  }

  protected abstract attempt(
    systemPrompt: string,
    messageHistory: Message[],
    tools: Tool[],
    options: TextGenerateOptions | undefined,
    signal: AbortSignal,
  ): AsyncIterable<ProviderSourceEvent>;

  async *#streamWithRetries(
    systemPrompt: string,
    history: Message[],
    tools: Tool[],
    options: TextGenerateOptions | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderSourceEvent> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        for await (const event of this.attempt(systemPrompt, history, tools, options, signal)) {
          if (event.type === 'error') throw event.error;
          yield event;
        }
        return;
      } catch (error) {
        if (signal.aborted) throw error;
        const providerError = toProviderError(error);
        if (providerError.code !== 'connection' || attempt > this.maxRetries) throw providerError;
        const delayMs = Math.min(this.retryDelayMs * 2 ** (attempt - 1), this.maxRetryDelayMs);
        yield { attempt, delayMs, error: providerError, resetOutput: true, type: 'retry' };
        await waitForRetry(delayMs, signal);
      }
    }
  }
}

type Provider = ChatProvider;

export {
  BaseProvider,
  chatModelConfigSchema,
  ChatProvider,
  isProviderError,
  modelAcceptsInput,
  modelBaseConfigSchema,
  modelConfigSchema,
  modelInputModalities,
  modelInputModalitiesSchema,
  modelOutputModalitiesSchema,
  modelProducesOutput,
  providerBaseConfigSchema,
  ProviderError,
  providerRuntimeConfigSchema,
  ProviderStream,
  samplingParametersConfigSchema,
  StreamStatus,
  textGenerateOptionsSchema,
  toProviderError,
};

export type {
  ModelConfig,
  Provider,
  ProviderBaseConfig,
  ProviderBaseConfigInput,
  ProviderErrorCode,
  ProviderErrorOptions,
  ProviderRuntimeConfigInput,
  ProviderSourceEvent,
  ProviderStreamEvent,
  TextGenerateOptions,
  ToolCallDraft,
  Usage,
};
