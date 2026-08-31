import { nanoid } from 'nanoid';
import { z } from 'zod';

import { artifactRefSchema } from './artifacts.js';
import { CONTENT_MODALITIES } from './content.js';
import { httpUrlSchema, runtimeSecretSchema, secretRefSchema } from './schemas.js';

import type { ArtifactOutputPublisher, ArtifactRef } from './artifacts.js';
import type { ContentModality, Message, MessageContent, ToolCallMessage } from './content.js';
import type { SecretHandle } from './schemas.js';
import type { Tool } from './tools.js';

/** Per-request generation policy, owned by an agent rather than by a provider model. */
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
type SamplingParametersConfig = z.infer<typeof samplingParametersConfigSchema>;

const requiredChatModalities = (direction: 'input' | 'output') =>
  z
    .array(z.enum(CONTENT_MODALITIES))
    .min(1)
    .refine((modalities) => modalities.includes('text'), {
      message: `Text ${direction} is required by the chat model interface.`,
    });
/**
 * What a surface may offer instead of a free-text box. A model ID and a
 * provider name are both drawn from something that exists — the configured
 * instances, and the models one of them reports — and typing either from memory
 * is how a configuration ends up naming a model no endpoint serves. The marker
 * travels on the schema so every editor built from a schema gets the choice,
 * rather than each one carrying its own list of which fields are names of what.
 *
 * A model catalog is resolved against the provider in scope: a sibling
 * `provider` field where the schema has one, and otherwise the provider whose
 * own entry is being edited.
 */
const PROVIDER_CATALOG = Object.freeze({ nox: Object.freeze({ catalog: 'provider' }) });
const MODEL_CATALOG = Object.freeze({ nox: Object.freeze({ catalog: 'model' }) });

const modelInputModalitiesSchema = requiredChatModalities('input');
const modelOutputModalitiesSchema = requiredChatModalities('output');
/** Facts intrinsic to a chat model, independent of which agent is using it. */
const modelBaseConfigSchema = z.object({
  inputModalities: modelInputModalitiesSchema.default((): ContentModality[] => ['text']),
  modelId: z.string().meta(MODEL_CATALOG),
  outputModalities: modelOutputModalitiesSchema.default((): ContentModality[] => ['text']),
});
/**
 * What a model is for. Discriminated rather than implied by which list a model
 * was declared in, because one endpoint commonly serves several kinds — the same
 * key and host answer chat and embeddings — and splitting the declaration would
 * make one configured service into two instances that can disagree about everything
 * else. Adding a kind here is what adding image or audio models will be.
 */
const MODEL_KINDS = ['chat', 'embedding'] as const;
type ModelKind = (typeof MODEL_KINDS)[number];

const chatModelConfigSchema = modelBaseConfigSchema
  .extend({
    contextWindow: z.number().int().positive().optional(),
    kind: z.literal('chat').default('chat'),
  })
  .strict();

/**
 * One embedding model, and the two things a store of its vectors must record.
 * `dimensions` is declared rather than discovered because whatever holds the
 * vectors has to allocate for them before it has seen one; it is also half of
 * the identity a stored vector belongs to — re-embedding the same text with a
 * different model produces a vector that is silently meaningless next to the
 * old ones, nothing fails, retrieval just quietly stops being about anything.
 */
const embeddingModelConfigSchema = z
  .object({
    dimensions: z.number().int().positive(),
    kind: z.literal('embedding'),
    /** Longer input is the caller's to split; the provider says where the line is. */
    maxInputTokens: z.number().int().positive().optional(),
    modelId: z.string().min(1).meta(MODEL_CATALOG),
  })
  .strict();

/**
 * A plain union rather than a discriminated one, so that a model declared
 * before kinds existed still parses. Discriminating requires the discriminator
 * to be present, and every `modelConfigs` written until now omits it — chat is
 * what they all were, and chat is what the default makes them. Chat is tried
 * first for that reason; an embedding model says so and fails the chat literal.
 */
const modelConfigSchema = z.union([chatModelConfigSchema, embeddingModelConfigSchema]);
type ModelConfig = z.infer<typeof modelConfigSchema>;
type ChatModelConfig = z.infer<typeof chatModelConfigSchema>;
type EmbeddingModelConfig = z.infer<typeof embeddingModelConfigSchema>;

function isChatModel(model: ModelConfig): model is ChatModelConfig {
  return model.kind === 'chat';
}
function isEmbeddingModel(model: ModelConfig): model is EmbeddingModelConfig {
  return model.kind === 'embedding';
}

function modelInputModalities(model: ChatModelConfig): readonly ContentModality[] {
  return model.inputModalities;
}
function modelAcceptsInput(model: ChatModelConfig, modality: ContentModality): boolean {
  return modelInputModalities(model).includes(modality);
}
function modelProducesOutput(model: ChatModelConfig, modality: ContentModality): boolean {
  return model.outputModalities.includes(modality);
}

/**
 * What every provider has, whatever it talks to. An endpoint and a credential
 * are deliberately absent: they belong to a provider reached over the network,
 * and one running inside this process has neither — requiring them here would
 * force a local model to invent a URL it never calls. The retry settings stay,
 * because retrying is the streaming contract's, not HTTP's.
 */
const providerFloorShape = {
  maxRetries: z.number().int().nonnegative().default(2),
  maxRetryDelayMs: z.number().nonnegative().default(30_000),
  retryDelayMs: z.number().nonnegative().default(500),
  timeoutMs: z.number().positive().optional(),
};
/**
 * The declared catalog, kept out of the floor above. A service reached over the
 * network serves models this installation has not named, so an operator says
 * which of them it means; a provider that holds its models — the local engine
 * loads exactly what its slots name — has no such gap to fill, and a list there
 * could only restate or contradict what it already loaded. Every provider
 * retries; not every provider has a catalog to declare.
 */
const providerConfigShape = {
  ...providerFloorShape,
  /** Every model this instance serves, of whatever kind. */
  modelConfigs: z.array(modelConfigSchema).optional(),
};
const providerBaseConfigSchema = z.object(providerConfigShape);
const providerRuntimeConfigSchema = z.object(providerConfigShape);

/** What a provider reached over the network adds: where it is, and who it says it is. */
const httpProviderConfigSchema = providerBaseConfigSchema.extend({
  apiKey: secretRefSchema.optional(),
  baseUrl: httpUrlSchema('The HTTP(S) base URL of the provider endpoint.'),
});
const httpProviderRuntimeConfigSchema = providerRuntimeConfigSchema.extend({
  // Structural by design: a host capability must survive package/module boundaries.
  apiKey: runtimeSecretSchema.optional(),
  baseUrl: httpUrlSchema('The HTTP(S) base URL of the provider endpoint.'),
});

type ProviderBaseConfig = z.infer<typeof providerBaseConfigSchema>;
type ProviderBaseConfigInput = z.input<typeof providerBaseConfigSchema>;
type ProviderRuntimeConfigInput = z.input<typeof providerRuntimeConfigSchema>;
type HttpProviderConfig = z.infer<typeof httpProviderConfigSchema>;
type HttpProviderConfigInput = z.input<typeof httpProviderConfigSchema>;
type HttpProviderRuntimeConfigInput = z.input<typeof httpProviderRuntimeConfigSchema>;

const textGenerateOptionsSchema = samplingParametersConfigSchema.extend({
  metadata: z.record(z.string(), z.unknown()).optional(),
  model: chatModelConfigSchema.optional(),
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

/**
 * What every provider is, whichever contract it answers: a named set of models,
 * and a policy for retrying an attempt at one. One list of models rather than
 * one per kind: an instance is a service, and which contracts it can actually
 * perform is answered by what it implements, not by which list it was declared in.
 */
abstract class BaseProvider {
  /**
   * Typed to the floor rather than to the base schema, so a provider whose
   * models are not declared but held — the local engine — can override with a
   * schema that has no `modelConfigs` to offer.
   */
  static readonly configSchema: z.ZodObject<typeof providerFloorShape> = providerBaseConfigSchema;
  protected timeoutMs?: number;
  protected modelConfigs: Record<string, ModelConfig> = {};
  protected readonly maxRetries: number;
  protected readonly maxRetryDelayMs: number;
  protected readonly retryDelayMs: number;

  constructor(input: ProviderRuntimeConfigInput) {
    const config = parseOrThrow(providerRuntimeConfigSchema, input);
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
  /** Whether this configured instance can actually perform one model contract. */
  public abstract supports(kind: ModelKind): boolean;
  public addModelConfig(model: ModelConfig): void {
    if (this.modelConfigs[model.modelId] !== undefined) {
      throw new Error(`Model config for modelId ${model.modelId} already exists.`);
    }
    this.modelConfigs[model.modelId] = model;
  }
  public getModelConfig(modelId: string): ModelConfig | undefined {
    return this.modelConfigs[modelId];
  }
  /** Every model, or only the ones of one kind. */
  public listModelConfigs(kind?: ModelKind): ModelConfig[] {
    const all = Object.values(this.modelConfigs);
    return kind === undefined ? all : all.filter((model) => model.kind === kind);
  }
  public chatModelConfig(modelId: string): ChatModelConfig | undefined {
    const model = this.modelConfigs[modelId];
    return model !== undefined && isChatModel(model) ? model : undefined;
  }
  public embeddingModelConfig(modelId: string): EmbeddingModelConfig | undefined {
    const model = this.modelConfigs[modelId];
    return model !== undefined && isEmbeddingModel(model) ? model : undefined;
  }
}

abstract class ChatProvider extends BaseProvider {
  public supports(kind: ModelKind): boolean {
    return kind === 'chat';
  }

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

/**
 * A chat provider that reaches its models over HTTP.
 *
 * Separate from `ChatProvider` rather than folded into it, because an adapter
 * that loads its model into this process answers the same streaming contract
 * while having no endpoint and no credential to configure. Kept as a subclass
 * of the chat hierarchy rather than a parallel one: there is one HTTP adapter
 * today, and inventing a way to share these two fields with a future HTTP
 * embedder would be designing for a caller that does not exist.
 */
abstract class HttpChatProvider extends ChatProvider {
  static override readonly configSchema = httpProviderConfigSchema;
  protected apiKey?: SecretHandle;
  protected baseUrl: string;

  constructor(input: HttpProviderRuntimeConfigInput) {
    super(input);
    const config = parseOrThrow(httpProviderRuntimeConfigSchema, input);
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
  }
}

/** One batch of text to turn into vectors. */
interface EmbedRequest {
  /**
   * Which configured model to use. Omitted, the provider picks its only one and
   * fails if it has several — guessing would attach the wrong model's identity
   * to vectors that outlive the call.
   */
  readonly modelId?: string;
  readonly signal?: AbortSignal;
  readonly texts: readonly string[];
}

/**
 * Vectors, and what they are vectors from.
 *
 * `modelId` and `dimensions` come back rather than being assumed from the
 * request, because they are what a store has to keep beside each vector to know
 * later whether it is still comparable to the ones next to it.
 */
interface EmbedResult {
  readonly dimensions: number;
  readonly modelId: string;
  readonly vectors: readonly (readonly number[])[];
}

/**
 * Turning text into vectors, as a capability rather than a kind of provider.
 * An interface and not a class because the same service commonly does both:
 * one endpoint, one credential, one instance that answers chat and embeddings.
 * Made a sibling class instead, every such service would have to be configured
 * twice and could then disagree with itself. What a provider can do is answered
 * by what it implements — so a new kind of model is a new capability, never a
 * second way to configure a provider.
 *
 * The call is a batch: indexing a corpus one round trip per document is the
 * difference between a pass that finishes and one that does not. Vectors come
 * back normalized to unit length so cosine similarity is a dot product everywhere.
 */
interface EmbeddingCapable {
  /** One vector per input text, in the order the texts were given. */
  embed(request: EmbedRequest): Promise<EmbedResult>;
}

function hasProviderSurface(value: unknown): value is BaseProvider {
  if (typeof value !== 'object' || value === null) return false;
  return [
    'addModelConfig',
    'embeddingModelConfig',
    'fetchModelIds',
    'getModelConfig',
    'listModelConfigs',
    'chatModelConfig',
    'supports',
  ].every((name) => typeof Reflect.get(value, name) === 'function');
}

function isEmbeddingCapable(value: unknown): value is BaseProvider & EmbeddingCapable {
  return (
    hasProviderSurface(value) &&
    value.supports('embedding') &&
    typeof Reflect.get(value, 'embed') === 'function'
  );
}

/**
 * Whether a configured provider can hold a conversation. Asked rather than
 * assumed: a provider is a service, and not every service chats — naming an
 * embedding-only instance where a conversation is expected is a configuration
 * mistake, and this lets it be reported as one instead of failing at the first
 * request.
 *
 * Structural by design: a compiled extension resolves its own copy of the API
 * while the host may have bundled one, so `instanceof` would reject a genuine
 * provider whose constructor identity differs.
 */
function isChatCapable(value: unknown): value is ChatProvider {
  return (
    hasProviderSurface(value) &&
    value.supports('chat') &&
    typeof Reflect.get(value, 'getMessageStream') === 'function'
  );
}

/**
 * Which configured provider instance, and which of its models. Both halves are
 * required: a service commonly serves several models, so naming only the
 * instance leaves the choice to be guessed later — and for anything that
 * outlives the call, such as a stored vector, the guess is what makes the
 * stored identity wrong.
 */
const modelReferenceSchema = z.object({
  model: z.string().min(1).meta(MODEL_CATALOG),
  provider: z.string().min(1).meta(PROVIDER_CATALOG),
});
type ModelReference = z.infer<typeof modelReferenceSchema>;

/**
 * One configured model, addressed by name for as long as its holder lives.
 * A handle is a reference and never a captured instance: every method resolves
 * the live provider again, so an extension may keep one for its whole lifetime
 * and never talk to a provider configuration has already replaced.
 */
interface ModelHandle {
  readonly reference: ModelReference;
}

interface EmbeddingModel extends ModelHandle {
  /** Re-read on each call, because `dimensions` decides how a vector is stored. */
  config(): EmbeddingModelConfig;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<EmbedResult>;
}

interface ChatModel extends ModelHandle {
  config(): ChatModelConfig;
  /**
   * `model` is absent from the options because the handle is the model; passing
   * one would be a second answer to a question the reference already settled.
   */
  stream(
    systemPrompt: string,
    history: readonly Message[],
    tools: readonly Tool[],
    options?: Omit<TextGenerateOptions, 'model'>,
  ): ProviderStream;
}

/**
 * Reaching a configured model from inside an extension: anything needing a model
 * of its own — a memory that embeds what it stores, one that extracts facts from
 * a transcript — becomes an ordinary extension instead of kernel code. Both
 * methods validate immediately, so a configuration mistake surfaces as a
 * component that reports itself unavailable rather than one that looks healthy
 * until the first request.
 */
interface ModelAccess {
  chat(reference: ModelReference): ChatModel;
  embedding(reference: ModelReference): EmbeddingModel;
}

type Provider = BaseProvider;

export {
  BaseProvider,
  chatModelConfigSchema,
  ChatProvider,
  embeddingModelConfigSchema,
  HttpChatProvider,
  httpProviderConfigSchema,
  httpProviderRuntimeConfigSchema,
  isChatCapable,
  isChatModel,
  isEmbeddingCapable,
  isEmbeddingModel,
  isProviderError,
  MODEL_CATALOG,
  MODEL_KINDS,
  modelAcceptsInput,
  modelBaseConfigSchema,
  modelConfigSchema,
  modelInputModalities,
  modelInputModalitiesSchema,
  modelOutputModalitiesSchema,
  modelProducesOutput,
  modelReferenceSchema,
  PROVIDER_CATALOG,
  providerBaseConfigSchema,
  ProviderError,
  providerFloorShape,
  providerRuntimeConfigSchema,
  ProviderStream,
  samplingParametersConfigSchema,
  StreamStatus,
  textGenerateOptionsSchema,
  toProviderError,
};

export type {
  ChatModel,
  ChatModelConfig,
  EmbeddingCapable,
  EmbeddingModel,
  EmbeddingModelConfig,
  EmbedRequest,
  EmbedResult,
  HttpProviderConfig,
  HttpProviderConfigInput,
  HttpProviderRuntimeConfigInput,
  ModelAccess,
  ModelConfig,
  ModelHandle,
  ModelKind,
  ModelReference,
  Provider,
  ProviderBaseConfig,
  ProviderBaseConfigInput,
  ProviderErrorCode,
  ProviderErrorOptions,
  ProviderRuntimeConfigInput,
  ProviderSourceEvent,
  ProviderStreamEvent,
  SamplingParametersConfig,
  TextGenerateOptions,
  ToolCallDraft,
  Usage,
};
