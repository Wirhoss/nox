import {
  EmbeddingProvider,
  embeddingProviderConfigSchema,
  type EmbedRequest,
  type EmbedResult,
  type Logger,
  z,
} from '@nox/extension-api';

import { ModelHost, type WorkerLike } from './modelHost';

import type { EmbeddedBatch } from './engine';

const localEmbeddingConfigSchema = embeddingProviderConfigSchema.extend({
  /** Where downloaded weights live. Omitted, the runtime uses its own cache. */
  cacheDirectory: z
    .string()
    .min(1)
    .optional()
    .meta({ nox: { help: 'ui.cacheDirectoryHelp', label: 'ui.cacheDirectory' } }),
  model: z
    .string()
    .min(1)
    .default('Xenova/all-MiniLM-L6-v2')
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
  type: z.literal('local'),
});

type LocalEmbeddingConfig = z.infer<typeof localEmbeddingConfigSchema>;

interface LocalEmbeddingOptions {
  readonly logger?: Logger;
  readonly spawn?: () => WorkerLike;
}

/**
 * Embeddings from a model held in this process's own worker.
 *
 * `fetchModelIds` answers with the one configured model rather than asking
 * anything: there is no catalogue to enumerate, and a local runtime knows about
 * exactly the weights it was pointed at.
 */
class LocalEmbeddingProvider extends EmbeddingProvider {
  public static override readonly configSchema = localEmbeddingConfigSchema;

  readonly #host: ModelHost;
  readonly #modelId: string;

  constructor(config: LocalEmbeddingConfig, options: LocalEmbeddingOptions = {}) {
    super(config);
    this.#modelId = config.model;
    this.#host = new ModelHost({
      engineOptions: {
        ...(config.cacheDirectory === undefined ? {} : { cacheDirectory: config.cacheDirectory }),
        modelId: config.model,
        precision: config.precision,
        threads: config.threads,
      },
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
    });
  }

  public fetchModelIds(): Promise<string[]> {
    return Promise.resolve([this.#modelId]);
  }

  public async embed(request: EmbedRequest): Promise<EmbedResult> {
    if (request.modelId !== undefined && request.modelId !== this.#modelId) {
      throw new Error(
        `This local provider holds "${this.#modelId}", not "${request.modelId}". ` +
          'Configure a second instance to serve another model.',
      );
    }
    if (request.texts.length === 0) {
      return { dimensions: this.declaredDimensions, modelId: this.#modelId, vectors: [] };
    }

    const batch = await this.#host.call<EmbeddedBatch>(
      { kind: 'embed', modelId: this.#modelId, texts: request.texts },
      request.signal,
    );
    return { dimensions: batch.dimensions, modelId: batch.modelId, vectors: batch.vectors };
  }

  /** Releases the thread and the weights it is holding. */
  public dispose(): Promise<void> {
    return this.#host.dispose();
  }

  /**
   * What configuration says the vectors are, for the empty batch that never
   * reaches the model. Zero when nothing was declared: a store has to record
   * what it actually received, and no vector was received.
   */
  private get declaredDimensions(): number {
    return this.getModelConfig(this.#modelId)?.dimensions ?? 0;
  }
}

export { localEmbeddingConfigSchema, LocalEmbeddingProvider };
export type { LocalEmbeddingConfig, LocalEmbeddingOptions };
