import { Worker } from 'node:worker_threads';

import type { EngineCall, HostMessage, WorkerMessage } from './protocol';
import type { Logger } from '@nox/extension-api';

/** The part of a worker this host uses, so a test can supply one that is not a thread. */
interface WorkerLike {
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  on(event: 'message', listener: (message: WorkerMessage) => void): void;
  postMessage(message: HostMessage): void;
  terminate(): Promise<unknown>;
}

interface ModelHostOptions {
  /** Passed to the worker as its `workerData`; the engine's own configuration. */
  readonly engineOptions: Readonly<Record<string, unknown>>;
  readonly logger?: Logger;
  /** How long a worker gets to leave on its own before it is killed. */
  readonly shutdownGraceMs?: number;
  /** Supplied by tests. Production spawns the worker beside this file. */
  readonly spawn?: () => WorkerLike;
}

interface Pending {
  readonly chunk?: (text: string) => void;
  readonly reject: (error: Error) => void;
  readonly resolve: (value: unknown) => void;
}

class WorkerGoneError extends Error {
  constructor(reason: string) {
    super(`The local model worker ${reason}.`);
    this.name = 'WorkerGoneError';
  }
}

/** Long enough for an interrupted call to leave the runtime, short enough to not hang a shutdown. */
const SHUTDOWN_GRACE_MS = 5_000;

/**
 * The worker beside this module, in whichever form this module is running.
 *
 * A built package is one bundled `.js` with the worker emitted next to it; the
 * sources are `.ts`. The extension is the same either way, so it asks what it
 * itself was loaded as rather than being told.
 */
function workerFile(): string {
  return import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js';
}

let nextCallId = 0;

/**
 * Owns the thread a local model runs on.
 *
 * A thread rather than this process, because inference is a long block of
 * arithmetic and tokenization: run on the main loop it would stall the gateway
 * mid-request, and the symptom — a server that goes briefly deaf — would look
 * like anything but a model. There is one host per configured instance, so the
 * chat model and the embedding model do not queue behind each other and no
 * scheduler has to decide which of them waits.
 *
 * The worker is spawned on the first call and never eagerly: loading weights
 * costs hundreds of megabytes and seconds of startup, and an instance that is
 * configured but unused should cost neither.
 */
class ModelHost {
  readonly #engineOptions: Readonly<Record<string, unknown>>;
  readonly #logger?: Logger;
  readonly #pending = new Map<string, Pending>();
  readonly #spawn: () => WorkerLike;

  readonly #shutdownGraceMs: number;

  #disposed = false;
  #worker?: WorkerLike;

  constructor(options: ModelHostOptions) {
    this.#engineOptions = options.engineOptions;
    this.#logger = options.logger;
    this.#shutdownGraceMs = options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
    this.#spawn =
      options.spawn ??
      ((): WorkerLike =>
        new Worker(new URL(workerFile(), import.meta.url), {
          workerData: this.#engineOptions,
        }) as unknown as WorkerLike);
  }

  public async call<T>(
    call: EngineCall,
    signal?: AbortSignal,
    onChunk?: (text: string) => void,
  ): Promise<T> {
    if (this.#disposed) throw new WorkerGoneError('has been released');
    signal?.throwIfAborted();

    const id = `call-${String(++nextCallId)}`;
    const worker = this.#ensureWorker();
    const settled = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, {
        ...(onChunk === undefined ? {} : { chunk: onChunk }),
        reject,
        resolve,
      });
    });

    const onAbort = (): void => {
      // Told, not just forgotten: a worker that is not informed keeps computing
      // a result nobody will read, on the one thread the next call needs.
      this.#worker?.postMessage({ id, kind: 'cancel' });
      this.#settle(id, (pending) => {
        pending.reject(new DOMException('The model call was aborted.', 'AbortError'));
      });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      worker.postMessage({ call, id, kind: 'call' });
      return (await settled) as T;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.#pending.delete(id);
    }
  }

  /**
   * A call whose progress is the point.
   *
   * The queue exists because the worker pushes and the consumer pulls, at
   * different rates: without one, a fast model would drop tokens the caller had
   * not asked for yet, and a slow consumer would apply no backpressure it could
   * not honour anyway across a thread boundary.
   */
  public async *stream(call: EngineCall, signal?: AbortSignal): AsyncGenerator<string, unknown> {
    const queue: string[] = [];
    let notify: (() => void) | undefined;
    let done: undefined | { readonly error?: unknown; readonly value?: unknown };

    const wake = (): void => {
      notify?.();
      notify = undefined;
    };
    const settled = this.call(call, signal, (text) => {
      queue.push(text);
      wake();
    })
      .then((value) => {
        done = { value };
      })
      .catch((error: unknown) => {
        done = { error };
      })
      .finally(wake);

    for (;;) {
      while (queue.length > 0) {
        const text = queue.shift();
        if (text !== undefined) yield text;
      }
      if (done !== undefined) break;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }

    await settled;
    const failure: unknown = done.error;
    if (failure instanceof Error) throw failure;
    if (failure !== undefined) throw new Error('The local model call failed.', { cause: failure });
    return done.value;
  }

  /**
   * Asks the thread to stop, and only kills it if it will not.
   *
   * Terminating outright is what the first version did, and against a real
   * runtime it crashed the process: a worker inside a native inference call is
   * not in a state that can be torn down, and the failure arrives as a fatal
   * signal rather than an exception anyone could handle. So the worker is told,
   * given a bounded moment to leave on its own, and terminated only if it does
   * not — by which point it is stuck, and a stuck thread is worth the risk.
   */
  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const worker = this.#worker;
    this.#worker = undefined;
    this.#rejectAll(new WorkerGoneError('has been released'));
    if (worker === undefined) return;

    const left = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        resolve(false);
      }, this.#shutdownGraceMs);
      worker.on('exit', () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
    try {
      worker.postMessage({ kind: 'shutdown' });
    } catch {
      // Already gone; nothing left to ask.
      return;
    }
    if (await left) return;
    this.#logger?.warn(
      { graceMs: this.#shutdownGraceMs },
      'The local model worker did not stop when asked; terminating it.',
    );
    await worker.terminate();
  }

  #ensureWorker(): WorkerLike {
    if (this.#worker !== undefined) return this.#worker;

    const worker = this.#spawn();
    this.#worker = worker;
    worker.on('message', (message) => {
      // A chunk is progress, not an answer: the call stays open.
      if (message.kind === 'chunk') {
        this.#pending.get(message.id)?.chunk?.(message.text);
        return;
      }
      this.#settle(message.id, (pending) => {
        if (message.kind === 'settled') pending.resolve(message.value);
        else if (message.error.aborted) {
          pending.reject(new DOMException(message.error.message, 'AbortError'));
        } else pending.reject(new Error(message.error.message));
      });
    });
    // A thread that dies takes every in-flight call with it. Rejecting here is
    // what keeps a crash from presenting as a request that never returns.
    worker.on('error', (error) => {
      this.#logger?.error({ err: error }, 'The local model worker failed.');
      this.#drop(worker, new WorkerGoneError(`failed: ${error.message}`));
    });
    worker.on('exit', (code) => {
      if (this.#worker !== worker) return;
      this.#drop(worker, new WorkerGoneError(`exited with code ${String(code)}`));
    });
    return worker;
  }

  /** Forgets a dead worker so the next call spawns a fresh one. */
  #drop(worker: WorkerLike, error: Error): void {
    if (this.#worker === worker) this.#worker = undefined;
    this.#rejectAll(error);
  }

  #rejectAll(error: Error): void {
    for (const [id, pending] of [...this.#pending]) {
      this.#pending.delete(id);
      pending.reject(error);
    }
  }

  #settle(id: string, apply: (pending: Pending) => void): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    apply(pending);
  }
}

export { ModelHost, WorkerGoneError };
export type { ModelHostOptions, WorkerLike };
