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
  /** Supplied by tests. Production spawns the worker beside this file. */
  readonly spawn?: () => WorkerLike;
}

interface Pending {
  readonly reject: (error: Error) => void;
  readonly resolve: (value: unknown) => void;
}

class WorkerGoneError extends Error {
  constructor(reason: string) {
    super(`The local model worker ${reason}.`);
    this.name = 'WorkerGoneError';
  }
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

  #disposed = false;
  #worker?: WorkerLike;

  constructor(options: ModelHostOptions) {
    this.#engineOptions = options.engineOptions;
    this.#logger = options.logger;
    this.#spawn =
      options.spawn ??
      ((): WorkerLike =>
        new Worker(new URL('./worker.ts', import.meta.url), {
          workerData: this.#engineOptions,
        }) as unknown as WorkerLike);
  }

  public async call<T>(call: EngineCall, signal?: AbortSignal): Promise<T> {
    if (this.#disposed) throw new WorkerGoneError('has been released');
    signal?.throwIfAborted();

    const id = `call-${String(++nextCallId)}`;
    const worker = this.#ensureWorker();
    const settled = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
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

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const worker = this.#worker;
    this.#worker = undefined;
    this.#rejectAll(new WorkerGoneError('has been released'));
    await worker?.terminate();
  }

  #ensureWorker(): WorkerLike {
    if (this.#worker !== undefined) return this.#worker;

    const worker = this.#spawn();
    this.#worker = worker;
    worker.on('message', (message) => {
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
