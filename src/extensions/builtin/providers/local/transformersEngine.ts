import type { EmbeddedBatch, EngineOptions, GenerationStats, InferenceEngine } from './engine';
import type { EmbedCall, GenerateCall } from './protocol';

/** The narrow shape this engine uses from the runtime, so the `unknown` module can be checked. */
interface FeatureExtractionOutput {
  readonly dims: readonly number[];
  tolist(): number[][] | number[][][];
}
type FeatureExtractor = (
  texts: readonly string[],
  options: { normalize: boolean; pooling: string },
) => Promise<FeatureExtractionOutput>;
interface GenerationInput {
  readonly content: string;
  readonly role: string;
}
type TextGenerator = (
  messages: readonly GenerationInput[],
  options: Readonly<Record<string, unknown>>,
) => Promise<unknown>;
type PipelineFactory = (
  task: string,
  model: string,
  options: Readonly<Record<string, unknown>>,
) => Promise<FeatureExtractor & TextGenerator>;

/** The runtime's own token streamer, used through the shape this engine needs. */
type StreamerFactory = new (
  tokenizer: unknown,
  options: { callback_function: (text: string) => void; skip_prompt: boolean },
) => unknown;

/**
 * The runtime's cooperative stop.
 *
 * Needed rather than nice: a native inference call cannot be interrupted from
 * outside, and terminating the thread while it is inside one takes the whole
 * process down with it. This is the only way an abort actually ends the work
 * rather than just stopping someone from reading it.
 */
type StoppingCriteriaFactory = new () => { interrupt(): void };

interface Tokenizer {
  apply_chat_template(
    messages: readonly GenerationInput[],
    options: Readonly<Record<string, unknown>>,
  ): unknown;
}

interface TransformersEnvironment {
  cacheDir: null | string;
  useBrowserCache: boolean;
  useFSCache: boolean;
}

/**
 * Forces the server runtime onto its filesystem cache.
 *
 * Bun exposes the browser Cache API, so Transformers.js otherwise prefers it
 * even though this is a server process. Bun backs that cache beside the package
 * under node_modules, which is read-only in the container and is not persisted.
 */
function configureEnvironment(module: unknown, cacheDirectory?: string): void {
  const candidate = (module as { env?: unknown }).env;
  if (candidate === null || typeof candidate !== 'object') {
    throw new TypeError('The local model runtime does not expose its environment.');
  }
  const environment = candidate as TransformersEnvironment;
  environment.useBrowserCache = false;
  environment.useFSCache = true;
  if (cacheDirectory !== undefined) environment.cacheDir = cacheDirectory;
}

function streamerOf(module: unknown): StreamerFactory {
  const candidate = (module as { TextStreamer?: unknown }).TextStreamer;
  if (typeof candidate !== 'function') {
    throw new TypeError('The local model runtime does not expose a token streamer.');
  }
  return candidate as StreamerFactory;
}

function stoppingCriteriaOf(module: unknown): StoppingCriteriaFactory {
  const candidate = (module as { InterruptableStoppingCriteria?: unknown })
    .InterruptableStoppingCriteria;
  if (typeof candidate !== 'function') {
    throw new TypeError('The local model runtime does not expose an interruptable stop.');
  }
  return candidate as StoppingCriteriaFactory;
}

/**
 * Counts what the model will actually read, or gives up rather than guessing.
 *
 * The template is applied because the count has to include it: the system turn,
 * the role markers and the generation prompt are all tokens the model reads,
 * and a count of the raw text would understate a short exchange badly. What
 * comes back is an encoding of tensors rather than an array, so the length is
 * the last dimension of `input_ids`.
 */
function promptTokenCount(
  generator: unknown,
  messages: readonly GenerationInput[],
): number | undefined {
  const tokenizer = Reflect.get(generator as object, 'tokenizer') as Tokenizer | undefined;
  if (typeof tokenizer?.apply_chat_template !== 'function') return undefined;
  try {
    const encoded: unknown = tokenizer.apply_chat_template(messages, {
      add_generation_prompt: true,
      tokenize: true,
    });
    if (Array.isArray(encoded)) return encoded.length;
    const inputIds: unknown = Reflect.get(encoded as object, 'input_ids');
    const dims: unknown =
      inputIds === undefined ? undefined : Reflect.get(inputIds as object, 'dims');
    const last: unknown = Array.isArray(dims) ? (dims as unknown[]).at(-1) : undefined;
    return typeof last === 'number' ? last : undefined;
  } catch {
    return undefined;
  }
}

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
  configureEnvironment(module, options.cacheDirectory);
  const pipeline = pipelineOf(module);
  const pipelines: Record<string, Promise<FeatureExtractor & TextGenerator>> = {};

  const open = async (task: string): Promise<FeatureExtractor & TextGenerator> => {
    pipelines[task] ??= pipeline(task, options.modelId, {
      ...(options.cacheDirectory === undefined ? {} : { cache_dir: options.cacheDirectory }),
      ...(options.precision === undefined ? {} : { dtype: options.precision }),
      device: 'cpu',
      ...(options.threads === undefined
        ? {}
        : { session_options: { intraOpNumThreads: options.threads } }),
    });
    return pipelines[task];
  };

  return {
    /**
     * Text as the model produces it.
     *
     * The runtime cannot be interrupted between tokens, so aborting is enforced
     * from the streamer callback: it is the only place that runs while
     * generation is in flight, and a batch nobody is waiting for should stop
     * costing the one thread the next call needs.
     */
    async *generate(
      call: GenerateCall,
      signal: AbortSignal,
    ): AsyncGenerator<string, GenerationStats> {
      signal.throwIfAborted();
      const openedAt = Date.now();
      const generate = await open('text-generation');
      const loadMs = Date.now() - openedAt;
      signal.throwIfAborted();

      const messages = [
        { content: call.systemPrompt, role: 'system' },
        ...call.messages.map((message) => ({ content: message.text, role: message.role })),
      ];
      const promptTokens = promptTokenCount(generate, messages);

      const queue: string[] = [];
      let wake: (() => void) | undefined;
      const startedAt = Date.now();
      let firstTokenAt: number | undefined;
      let lastTokenAt = startedAt;
      let generatedTokens = 0;

      const stopper = new (stoppingCriteriaOf(module))();
      const streamerFactory = streamerOf(module);
      const streamer = new streamerFactory(Reflect.get(generate, 'tokenizer'), {
        // One callback is one decoded token, which is what makes counting here
        // a measurement rather than an estimate from character length.
        callback_function: (text: string) => {
          generatedTokens += 1;
          firstTokenAt ??= Date.now();
          lastTokenAt = Date.now();
          queue.push(text);
          wake?.();
          wake = undefined;
        },
        skip_prompt: true,
      });
      const onAbort = (): void => {
        stopper.interrupt();
      };
      signal.addEventListener('abort', onAbort, { once: true });

      const finished = generate(messages, {
        ...(call.maxTokens === undefined ? {} : { max_new_tokens: call.maxTokens }),
        ...(call.stop === undefined ? {} : { stop_strings: [...call.stop] }),
        ...(call.temperature === undefined ? {} : { temperature: call.temperature }),
        ...(call.topP === undefined ? {} : { top_p: call.topP }),
        stopping_criteria: stopper,
        streamer,
      });
      // A holder rather than a plain flag: it is set from a callback, and flow
      // analysis would otherwise read the loop as never able to end.
      const state = { settled: false };
      const completion = finished.finally(() => {
        state.settled = true;
        wake?.();
        wake = undefined;
      });

      try {
        for (;;) {
          while (queue.length > 0) {
            const text = queue.shift();
            if (text !== undefined) yield text;
          }
          if (signal.aborted) break;
          if (state.settled) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        // Always awaited, abort included. The interrupt makes this return
        // promptly, and leaving it unawaited is what would let the thread be
        // torn down mid-call — which is a process-level crash, not an error.
        await completion;
        signal.throwIfAborted();
      } finally {
        signal.removeEventListener('abort', onAbort);
      }

      return {
        decodeMs: firstTokenAt === undefined ? 0 : lastTokenAt - firstTokenAt,
        generatedTokens,
        loadMs,
        ...(promptTokens === undefined ? {} : { promptTokens }),
        ttftMs: (firstTokenAt ?? lastTokenAt) - startedAt,
      };
    },

    async embed(call: EmbedCall, signal: AbortSignal): Promise<EmbeddedBatch> {
      signal.throwIfAborted();
      const extract = await open('feature-extraction');
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
        vectors: rows.map((row) => (Array.isArray(row[0]) ? row[0] : (row as number[]))),
      };
    },
  };
}

export { createTransformersEngine };
