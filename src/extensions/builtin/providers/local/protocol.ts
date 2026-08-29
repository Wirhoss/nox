/**
 * What crosses the worker boundary, and nothing else.
 *
 * Every message carries an `id` because the boundary is a pipe, not a call
 * stack: several requests are in flight at once and the replies come back in
 * whatever order the work finished. Cancellation is a message of its own for
 * the same reason — an `AbortSignal` does not survive a structured clone, so
 * the host has to say out loud which request it no longer wants.
 */
interface EmbedCall {
  readonly kind: 'embed';
  readonly modelId?: string;
  readonly texts: readonly string[];
}

/** Every call the worker can be asked to perform, before it is addressed. */
type EngineCall = EmbedCall;

type HostMessage =
  | { readonly call: EngineCall; readonly id: string; readonly kind: 'call' }
  | { readonly id: string; readonly kind: 'cancel' };

interface EngineFailure {
  readonly message: string;
  /** Distinguishes work the host asked to stop from work that broke. */
  readonly aborted: boolean;
}

type WorkerMessage =
  | { readonly error: EngineFailure; readonly id: string; readonly kind: 'failed' }
  | { readonly id: string; readonly kind: 'settled'; readonly value: unknown };

export type { EmbedCall, EngineCall, EngineFailure, HostMessage, WorkerMessage };
