import {
  ChatProvider,
  contentToString,
  type EmbeddingCapable,
  type EmbedRequest,
  type EmbedResult,
  type Logger,
  type Message,
  type ModelKind,
  providerBaseConfigSchema,
  ProviderError,
  type ProviderSourceEvent,
  type TextGenerateOptions,
  type Tool,
  toProviderError,
  z,
} from '@nox/extension-api';

import { ModelHost, type WorkerLike } from './modelHost';

import type { EmbeddedBatch, GenerationStats } from './engine';
import type { GenerateCall } from './protocol';

/**
 * One model the local engine loads, and whether it is loaded at all.
 *
 * `enabled` rather than an absent block, so that turning a model off keeps the
 * settings chosen for it. An operator who disables the language model to free
 * memory should not have to remember which weights they had picked.
 */
const localModelShape = {
  enabled: z
    .boolean()
    .default(false)
    .meta({ nox: { label: 'ui.enabled' } }),
  model: z
    .string()
    .min(1)
    .optional()
    .meta({ nox: { help: 'ui.modelHelp', label: 'ui.model' } }),
  precision: z
    .enum(['fp32', 'fp16', 'q8', 'q4'])
    .default('q8')
    .meta({ nox: { help: 'ui.precisionHelp', label: 'ui.precision' } }),
  /**
   * Deliberately low by default. The runtime would otherwise take every core it
   * finds, and it is sharing this machine with the server that is answering.
   */
  threads: z
    .number()
    .int()
    .positive()
    .max(64)
    .default(2)
    .meta({ nox: { help: 'ui.threadsHelp', label: 'ui.threads' } }),
};

/**
 * The engine as configured, refusing an entry that loads nothing.
 *
 * The refusal is what keeps this out of configuration until somebody asks for
 * it. A single-instance contribution whose schema is satisfied by its type
 * alone is seeded into the file on every boot, and the settings list only
 * offers what is *not* configured — so an engine that accepted an empty entry
 * would write itself in, disappear from the list of things you can add, and
 * commit an installation that never wanted a local model to carrying one.
 * Nothing is loaded here until a model is named, so an entry naming none is not
 * a configuration of this engine; it is the absence of one.
 */
const localProviderConfigSchema = providerBaseConfigSchema
  .extend({
    /** Where downloaded weights live. Omitted, they land under the data directory. */
    cacheDirectory: z
      .string()
      .min(1)
      .optional()
      .meta({ nox: { help: 'ui.cacheDirectoryHelp', label: 'ui.cacheDirectory' } }),
    embedding: z
      .object({
        ...localModelShape,
        /** What a store of these vectors has to allocate for before it sees one. */
        dimensions: z
          .number()
          .int()
          .positive()
          .optional()
          .meta({ nox: { help: 'ui.dimensionsHelp', label: 'ui.dimensions' } }),
      })
      .optional(),
    llm: z.object(localModelShape).optional(),
    type: z.literal('local'),
  })
  .superRefine((config, context) => {
    for (const [slot, model] of [
      ['llm', config.llm],
      ['embedding', config.embedding],
    ] as const) {
      if (model?.enabled !== true || model.model !== undefined) continue;
      context.addIssue({
        code: 'custom',
        message: 'Name the model to load, or turn this one off.',
        path: [slot, 'model'],
      });
    }
    const chatModelId = config.llm?.enabled === true ? config.llm.model : undefined;
    const embeddingModelId =
      config.embedding?.enabled === true ? config.embedding.model : undefined;
    if (
      chatModelId !== undefined &&
      embeddingModelId !== undefined &&
      chatModelId === embeddingModelId
    ) {
      context.addIssue({
        code: 'custom',
        message: 'The chat and embedding slots must name different models.',
        path: ['embedding', 'model'],
      });
    }

    for (const [index, model] of (config.modelConfigs ?? []).entries()) {
      const expectedKind =
        model.modelId === chatModelId
          ? 'chat'
          : model.modelId === embeddingModelId
            ? 'embedding'
            : undefined;
      if (expectedKind === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Model metadata must describe an enabled local model.',
          path: ['modelConfigs', index, 'modelId'],
        });
        continue;
      }
      if (model.kind !== expectedKind) {
        context.addIssue({
          code: 'custom',
          message: `This enabled local model is used for ${expectedKind}.`,
          path: ['modelConfigs', index, 'kind'],
        });
      }
      if (
        expectedKind === 'embedding' &&
        config.embedding?.dimensions !== undefined &&
        model.kind === 'embedding' &&
        model.dimensions !== config.embedding.dimensions
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Use one dimension count for this embedding model.',
          path: ['modelConfigs', index, 'dimensions'],
        });
      }
    }

    if (chatModelId !== undefined || embeddingModelId !== undefined) return;
    context.addIssue({
      code: 'custom',
      message: 'Enable a language model, an embedding model, or both.',
      path: ['llm', 'enabled'],
    });
  });

type LocalProviderConfig = z.infer<typeof localProviderConfigSchema>;

interface LocalProviderOptions {
  /**
   * Where weights are cached when configuration does not say. Supplied by the
   * extension from the host's data directory, so downloads land with the rest
   * of this installation rather than wherever the process happened to start.
   */
  readonly defaultCacheDirectory?: string;
  readonly logger?: Logger;
  readonly shutdownGraceMs?: number;
  readonly spawn?: () => WorkerLike;
}

/** Only original speech survives the crossing; everything else is Nox's own bookkeeping. */
function transcript(messages: readonly Message[]): GenerateCall['messages'] {
  return messages.flatMap((message) => {
    if (message.role !== 'assistant' && message.role !== 'user') return [];
    const text = contentToString(message.content).trim();
    return text.length === 0 ? [] : [{ role: message.role, text }];
  });
}

/**
 * Models Nox runs itself, on the CPU of the machine it is installed on.
 *
 * One configured instance serving both kinds, because it is one engine: the
 * same weight cache, the same thread budget, the same decision to run models
 * locally at all. Split into two instances it could contradict itself about
 * every one of those, which is what a second entry would really be buying.
 *
 * Two worker threads inside it, though. That is an implementation detail rather
 * than a configuration one, and it is what keeps an embedding pass from waiting
 * behind a generation that is still writing.
 *
 * Tool calling is refused rather than ignored. A model this size does not
 * reliably emit callable tool syntax, and an adapter that accepted the tools
 * and quietly never called any of them would look like an agent that had
 * decided not to act, which is the one failure that reads as a decision.
 */
class LocalProvider extends ChatProvider implements EmbeddingCapable {
  public static override readonly configSchema = localProviderConfigSchema;

  readonly #chatModelId?: string;
  readonly #embeddingModelId?: string;
  readonly #hosts: { chat?: ModelHost; embedding?: ModelHost } = {};
  readonly #logger?: Logger;

  constructor(config: LocalProviderConfig, options: LocalProviderOptions = {}) {
    super(config);
    this.#logger = options.logger;
    const cacheDirectory = config.cacheDirectory ?? options.defaultCacheDirectory;
    const host = (modelId: string, precision: string, threads: number): ModelHost =>
      new ModelHost({
        engineOptions: {
          ...(cacheDirectory === undefined ? {} : { cacheDirectory }),
          modelId,
          precision,
          threads,
        },
        ...(options.logger === undefined ? {} : { logger: options.logger }),
        ...(options.shutdownGraceMs === undefined
          ? {}
          : { shutdownGraceMs: options.shutdownGraceMs }),
        ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
      });

    const llm = config.llm;
    const embedding = config.embedding;
    if (llm?.enabled === true && llm.model !== undefined) {
      this.#chatModelId = llm.model;
      this.#hosts.chat = host(llm.model, llm.precision, llm.threads);
      if (this.chatModelConfig(llm.model) === undefined) {
        this.addModelConfig({
          inputModalities: ['text'],
          kind: 'chat',
          modelId: llm.model,
          outputModalities: ['text'],
        });
      }
    }
    if (embedding?.enabled === true && embedding.model !== undefined) {
      this.#embeddingModelId = embedding.model;
      this.#hosts.embedding = host(embedding.model, embedding.precision, embedding.threads);
      if (
        embedding.dimensions !== undefined &&
        this.embeddingModelConfig(embedding.model) === undefined
      ) {
        this.addModelConfig({
          dimensions: embedding.dimensions,
          kind: 'embedding',
          modelId: embedding.model,
        });
      }
    }
  }

  public override supports(kind: ModelKind): boolean {
    return kind === 'chat' ? this.#hosts.chat !== undefined : this.#hosts.embedding !== undefined;
  }

  public override fetchModelIds(): Promise<string[]> {
    return Promise.resolve([
      ...new Set([this.#chatModelId, this.#embeddingModelId].filter((id) => id !== undefined)),
    ]);
  }

  /** Releases the threads and the weights they are holding. */
  public async dispose(): Promise<void> {
    await Promise.all([this.#hosts.chat?.dispose(), this.#hosts.embedding?.dispose()]);
  }

  public async embed(request: EmbedRequest): Promise<EmbedResult> {
    const host = this.#hosts.embedding;
    const modelId = this.#embeddingModelId;
    if (host === undefined || modelId === undefined) {
      throw new Error('This local provider has no embedding model enabled.');
    }
    if (request.modelId !== undefined && request.modelId !== modelId) {
      throw new Error(
        `This local provider holds "${modelId}", not "${request.modelId}". ` +
          'Change its embedding model to serve different weights.',
      );
    }
    if (request.texts.length === 0) {
      return {
        dimensions: this.embeddingModelConfig(modelId)?.dimensions ?? 0,
        modelId,
        vectors: [],
      };
    }

    const batch = await host.call<EmbeddedBatch>(
      { kind: 'embed', modelId, texts: request.texts },
      request.signal,
    );
    return { dimensions: batch.dimensions, modelId: batch.modelId, vectors: batch.vectors };
  }

  protected override async *attempt(
    systemPrompt: string,
    messageHistory: Message[],
    tools: Tool[],
    options: TextGenerateOptions | undefined,
    signal: AbortSignal,
  ): AsyncIterable<ProviderSourceEvent> {
    const host = this.#hosts.chat;
    const modelId = this.#chatModelId;
    if (host === undefined || modelId === undefined) {
      throw new ProviderError(
        'invalid_request',
        'This local provider has no language model enabled.',
      );
    }
    if (options?.model !== undefined && options.model.modelId !== modelId) {
      throw new ProviderError(
        'invalid_request',
        `This local provider holds "${modelId}", not "${options.model.modelId}".`,
      );
    }
    if (tools.length > 0) {
      throw new ProviderError(
        'invalid_request',
        `The local model "${modelId}" cannot call tools. Grant this agent no tool sets, ` +
          'or point it at a provider that supports them.',
      );
    }

    const call: GenerateCall = {
      kind: 'generate',
      ...(options?.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      messages: transcript(messageHistory),
      modelId,
      ...(options?.stop === undefined ? {} : { stop: options.stop }),
      systemPrompt,
      ...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options?.topP === undefined ? {} : { topP: options.topP }),
    };

    let stats: GenerationStats;
    try {
      // Iterated by hand: `for await` throws away a generator's return value,
      // and here that value is what the completion cost.
      const tokens = host.stream(call, signal);
      let next = await tokens.next();
      while (next.done !== true) {
        yield { text: next.value, type: 'textFragment' };
        next = await tokens.next();
      }
      stats = next.value as GenerationStats;
    } catch (error) {
      if (signal.aborted) throw error;
      throw toProviderError(error, `The local model "${modelId}" failed.`);
    }

    this.#report(modelId, stats);
    // Counted in the worker, where the tokens are, rather than estimated from
    // characters out here. Nothing was billed, but something was spent.
    yield {
      type: 'end',
      usage: { inputTokens: stats.promptTokens ?? 0, outputTokens: stats.generatedTokens },
    };
  }

  /** Rates, not just durations: a duration alone cannot be compared across prompts. */
  #report(modelId: string, stats: GenerationStats): void {
    const perSecond = (count: number, ms: number): number =>
      ms <= 0 ? 0 : Math.round((count / ms) * 1000);
    this.#logger?.debug(
      {
        decodeTokensPerSecond: perSecond(Math.max(0, stats.generatedTokens - 1), stats.decodeMs),
        generatedTokens: stats.generatedTokens,
        loadMs: stats.loadMs,
        modelId,
        ...(stats.promptTokens === undefined
          ? {}
          : {
              promptTokens: stats.promptTokens,
              promptTokensPerSecond: perSecond(stats.promptTokens, stats.ttftMs),
            }),
        ttftMs: stats.ttftMs,
      },
      'Local model completion.',
    );
  }
}

export { LocalProvider, localProviderConfigSchema };
export type { LocalProviderConfig, LocalProviderOptions };
