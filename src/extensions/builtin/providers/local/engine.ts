import type { EmbedCall } from './protocol';

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

export type { EmbeddedBatch, EngineOptions, InferenceEngine };
