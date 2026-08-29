import type { EmbeddedBatch, EngineOptions, InferenceEngine } from './engine';
import type { EmbedCall } from './protocol';

/** The narrow shape this engine uses from the runtime, so the `unknown` module can be checked. */
interface FeatureExtractionOutput {
  readonly dims: readonly number[];
  tolist(): number[][] | number[][][];
}
type FeatureExtractor = (
  texts: readonly string[],
  options: { normalize: boolean; pooling: string },
) => Promise<FeatureExtractionOutput>;
type PipelineFactory = (
  task: string,
  model: string,
  options: Readonly<Record<string, unknown>>,
) => Promise<FeatureExtractor>;

function pipelineOf(module: unknown): PipelineFactory {
  const candidate = (module as { pipeline?: unknown }).pipeline;
  if (typeof candidate !== 'function') {
    throw new TypeError('The local model runtime does not expose a pipeline factory.');
  }
  return candidate as PipelineFactory;
}

/**
 * Mean-pooled, unit-normalized sentence embeddings.
 *
 * Pooling and normalization are asked of the runtime rather than done here: it
 * already has the attention mask, and a mean that ignores padding is not the
 * same mean as one that does not. Normalizing at this depth is what lets every
 * caller above treat cosine similarity as a dot product.
 */
function createTransformersEngine(module: unknown, options: EngineOptions): InferenceEngine {
  const pipeline = pipelineOf(module);
  let extractor: Promise<FeatureExtractor> | undefined;

  const open = async (): Promise<FeatureExtractor> => {
    extractor ??= pipeline('feature-extraction', options.modelId, {
      ...(options.cacheDirectory === undefined ? {} : { cache_dir: options.cacheDirectory }),
      ...(options.precision === undefined ? {} : { dtype: options.precision }),
      device: 'cpu',
      ...(options.threads === undefined
        ? {}
        : { session_options: { intraOpNumThreads: options.threads } }),
    });
    return extractor;
  };

  return {
    async embed(call: EmbedCall, signal: AbortSignal): Promise<EmbeddedBatch> {
      signal.throwIfAborted();
      const extract = await open();
      signal.throwIfAborted();
      if (call.texts.length === 0) {
        return { dimensions: 0, modelId: options.modelId, vectors: [] };
      }

      const output = await extract(call.texts, { normalize: true, pooling: 'mean' });
      // The runtime cannot be interrupted mid-tensor, so the check that matters
      // is here: an abandoned batch is dropped rather than returned to nobody.
      signal.throwIfAborted();
      const dimensions = output.dims.at(-1) ?? 0;
      const rows = output.tolist();
      return {
        dimensions,
        modelId: options.modelId,
        vectors: rows.map((row) => (Array.isArray(row[0]) ? (row[0]) : (row as number[]))),
      };
    },
  };
}

export { createTransformersEngine };
