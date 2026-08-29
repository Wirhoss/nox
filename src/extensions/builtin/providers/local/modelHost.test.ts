import { describe, expect, test } from 'bun:test';

import { ModelHost, type WorkerLike } from './modelHost';

import type { HostMessage, WorkerMessage } from './protocol';

type Listener = (payload: never) => void;

/**
 * A worker that is not a thread.
 *
 * The protocol is what these tests are about — correlation, cancellation, a
 * thread that dies — and none of that needs a model. Spawning a real worker
 * here would trade every one of these assertions for a weight download.
 */
class FakeWorker implements WorkerLike {
  public readonly received: HostMessage[] = [];
  public terminated = 0;

  readonly #listeners = new Map<string, Listener[]>();

  public on(event: string, listener: Listener): void {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
  }

  /** Leaves when asked, unless a test wants a worker that will not. */
  public ignoresShutdown = false;

  public postMessage(message: HostMessage): void {
    this.received.push(message);
    if (message.kind === 'shutdown' && !this.ignoresShutdown) this.exit(0);
  }

  public terminate(): Promise<number> {
    this.terminated += 1;
    return Promise.resolve(0);
  }

  public reply(message: WorkerMessage): void {
    this.#emit('message', message);
  }

  public crash(error: Error): void {
    this.#emit('error', error);
  }

  public exit(code: number): void {
    this.#emit('exit', code);
  }

  /** Ids of the calls this worker was asked to perform, in arrival order. */
  public get calls(): string[] {
    return this.received.filter((message) => message.kind === 'call').map(({ id }) => id);
  }

  #emit(event: string, payload: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(payload as never);
  }
}

/** Mirrors the kernel's own suites: the rejection is a value to assert on. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject, but it resolved.');
}

function hosted(): { host: ModelHost; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const host = new ModelHost({
    engineOptions: {},
    shutdownGraceMs: 20,
    spawn: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  return { host, workers };
}

describe('the local model host', () => {
  test('does not start a thread until something is asked of it', () => {
    const { workers } = hosted();

    expect(workers).toHaveLength(0);
  });

  test('answers concurrent calls by id rather than by arrival order', async () => {
    const { host, workers } = hosted();
    const first = host.call<string>({ kind: 'embed', texts: ['one'] });
    const second = host.call<string>({ kind: 'embed', texts: ['two'] });
    const worker = workers[0];
    if (worker === undefined) throw new Error('Expected a worker.');
    const [firstId, secondId] = worker.calls;
    if (firstId === undefined || secondId === undefined) throw new Error('Expected two calls.');

    worker.reply({ id: secondId, kind: 'settled', value: 'second' });
    worker.reply({ id: firstId, kind: 'settled', value: 'first' });

    expect(await first).toBe('first');
    expect(await second).toBe('second');
    expect(workers).toHaveLength(1);
  });

  test('tells the worker to stop when the caller aborts', async () => {
    const { host, workers } = hosted();
    const controller = new AbortController();
    const call = host.call({ kind: 'embed', texts: ['one'] }, controller.signal);
    const worker = workers[0];
    if (worker === undefined) throw new Error('Expected a worker.');

    controller.abort();

    expect(await rejection(call)).toMatchObject({ name: 'AbortError' });
    // Abandoning the promise is not enough: the thread would keep computing a
    // result nobody reads, on the one core the next call needs.
    expect(worker.received.at(-1)).toMatchObject({ kind: 'cancel' });
  });

  test('rejects everything in flight when the thread dies', async () => {
    const { host, workers } = hosted();
    const call = host.call({ kind: 'embed', texts: ['one'] });
    const worker = workers[0];
    if (worker === undefined) throw new Error('Expected a worker.');

    worker.crash(new Error('out of memory'));

    // A crash that left callers waiting would present as a request that never
    // returns, which is the one failure nobody can diagnose.
    expect(String(await rejection(call))).toContain('out of memory');
  });

  test('starts a fresh thread for the next call after one has died', async () => {
    const { host, workers } = hosted();
    const first = host.call({ kind: 'embed', texts: ['one'] });
    workers[0]?.exit(1);
    expect(String(await rejection(first))).toContain('exited with code 1');

    const second = host.call<string>({ kind: 'embed', texts: ['two'] });
    const replacement = workers[1];
    const callId = replacement?.calls[0];
    if (replacement === undefined || callId === undefined) throw new Error('Expected a respawn.');
    replacement.reply({ id: callId, kind: 'settled', value: 'recovered' });

    expect(await second).toBe('recovered');
  });

  test('surfaces a worker failure as the error it was, and an abort as an abort', async () => {
    const { host, workers } = hosted();
    const call = host.call({ kind: 'embed', texts: ['one'] });
    const worker = workers[0];
    const callId = worker?.calls[0];
    if (worker === undefined || callId === undefined) throw new Error('Expected a call.');

    worker.reply({
      error: { aborted: false, message: 'the weights are missing' },
      id: callId,
      kind: 'failed',
    });

    expect(String(await rejection(call))).toContain('the weights are missing');
  });

  test('asks the thread to stop rather than killing it where it stands', async () => {
    const { host, workers } = hosted();
    const inFlight = host.call({ kind: 'embed', texts: ['one'] });

    await host.dispose();

    expect(String(await rejection(inFlight))).toContain('has been released');
    // Terminating a worker that is inside a native inference call takes the
    // whole process down, so a worker that leaves on its own is never killed.
    expect(workers[0]?.received.at(-1)).toMatchObject({ kind: 'shutdown' });
    expect(workers[0]?.terminated).toBe(0);
    expect(String(await rejection(host.call({ kind: 'embed', texts: ['two'] })))).toContain(
      'has been released',
    );
  });

  test('kills a thread that will not stop when asked', async () => {
    const { host, workers } = hosted();
    void host.call({ kind: 'embed', texts: ['one'] }).catch(() => undefined);
    const worker = workers[0];
    if (worker === undefined) throw new Error('Expected a worker.');
    worker.ignoresShutdown = true;

    await host.dispose();

    // By now it is stuck, and a stuck thread is worth the risk.
    expect(worker.terminated).toBe(1);
  });
});
