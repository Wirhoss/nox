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

/**
 * One completion, as plain text.
 *
 * The transcript is projected to roles and text rather than passed as Nox
 * messages: everything here is structured-cloned across a thread boundary, and
 * a shape with artifacts, tool calls and dates in it would either not survive
 * the copy or would carry far more than a local model can read.
 */
interface GenerateCall {
  readonly kind: 'generate';
  readonly maxTokens?: number;
  readonly messages: readonly { readonly role: 'assistant' | 'user'; readonly text: string }[];
  readonly modelId?: string;
  readonly stop?: readonly string[];
  readonly systemPrompt: string;
  readonly temperature?: number;
  readonly topP?: number;
}

/** Every call the worker can be asked to perform, before it is addressed. */
type EngineCall = EmbedCall | GenerateCall;

type HostMessage =
  | { readonly call: EngineCall; readonly id: string; readonly kind: 'call' }
  | { readonly id: string; readonly kind: 'cancel' }
  /**
   * Asks the worker to stop and exit on its own. Terminating it instead would
   * tear the thread down wherever it happened to be — and where it happens to
   * be is usually inside a native inference call, which takes the whole process
   * with it rather than raising anything catchable.
   */
  | { readonly kind: 'shutdown' };

interface EngineFailure {
  readonly message: string;
  /** Distinguishes work the host asked to stop from work that broke. */
  readonly aborted: boolean;
}

/**
 * `chunk` is what makes generation usable: a local model produces tokens over
 * seconds, and a caller that only learns the answer when the last one arrives
 * has no way to show it arriving.
 */
type WorkerMessage =
  | { readonly error: EngineFailure; readonly id: string; readonly kind: 'failed' }
  | { readonly id: string; readonly kind: 'chunk'; readonly text: string }
  | { readonly id: string; readonly kind: 'settled'; readonly value: unknown };

export type { EmbedCall, EngineCall, EngineFailure, GenerateCall, HostMessage, WorkerMessage };
