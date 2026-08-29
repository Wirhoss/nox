import type { EmbedCall, GenerateCall } from './protocol';

/**
 * The model runtime, named as an interface so it is the one replaceable part.
 *
 * Everything above it — the thread, the protocol, cancellation, the provider —
 * is about owning a model, not about which library loads it. Keeping the two
 * apart is also the only way any of it is testable: a suite that had to fetch
 * hundreds of megabytes of weights to check that cancellation works would not
 * be run.
 */
interface InferenceEngine {
  /** One vector per text, in the order given, normalized to unit length. */
  embed(call: EmbedCall, signal: AbortSignal): Promise<EmbeddedBatch>;
  /**
   * Text as it is produced, so a caller can show an answer arriving, and what
   * producing it cost as its return value.
   */
  generate(call: GenerateCall, signal: AbortSignal): AsyncGenerator<string, GenerationStats>;
}

/**
 * What one completion cost, measured where the tokens are.
 *
 * In the worker rather than around the call, because from outside the boundary
 * the only observable is elapsed wall time — which folds loading the model,
 * reading the prompt and writing the answer into one number that says nothing
 * about which of the three is slow. These are the three separately: `loadMs` is
 * paid once per worker, `ttftMs` is dominated by reading the prompt, and the
 * decode rate is what a longer answer will actually cost.
 */
interface GenerationStats {
  /** Milliseconds from the first token to the last. */
  readonly decodeMs: number;
  readonly generatedTokens: number;
  /** Milliseconds spent loading weights. Zero on every call after the first. */
  readonly loadMs: number;
  /** Absent when the runtime could not tokenize the prompt for counting. */
  readonly promptTokens?: number;
  /** Milliseconds from the call starting to the first token arriving. */
  readonly ttftMs: number;
}

interface EmbeddedBatch {
  readonly dimensions: number;
  readonly modelId: string;
  readonly vectors: readonly (readonly number[])[];
}

/** How the worker is told which runtime to load, and how to configure it. */
interface EngineOptions {
  readonly cacheDirectory?: string;
  readonly modelId: string;
  /** Weight precision. Only meaningful to a runtime that quantizes. */
  readonly precision?: string;
  /** Kept low by default: this thread shares a machine with a server that is answering. */
  readonly threads?: number;
}

export type { EmbeddedBatch, EngineOptions, GenerationStats, InferenceEngine };
