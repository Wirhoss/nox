import { describe, expect, test } from 'bun:test';

import { SerialQueue } from './serialQueue';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('SerialQueue', () => {
  test('runs tasks one at a time, in submission order', async () => {
    const queue = new SerialQueue();
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;

    const task = (name: string, delay: number) => async (): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(delay);
      order.push(name);
      active -= 1;
    };

    // The slow task is queued first: without serialization the fast ones finish
    // ahead of it and the recorded order differs from submission order.
    await Promise.all([
      queue.run(task('slow', 20)),
      queue.run(task('fast', 1)),
      queue.run(task('faster', 0)),
    ]);

    expect(order).toEqual(['slow', 'fast', 'faster']);
    expect(maxActive).toBe(1);
  });

  test('a rejected task does not block the tasks behind it', async () => {
    const queue = new SerialQueue();

    const failed = queue.run(async () => { throw new Error('boom'); });
    const after = queue.run(async () => 'ok');

    await expect(failed).rejects.toThrow('boom');
    await expect(after).resolves.toBe('ok');
  });

  test('propagates the task result to its own caller', async () => {
    const queue = new SerialQueue();
    await expect(queue.run(async () => 42)).resolves.toBe(42);
  });

  test('drain waits for queued work to settle', async () => {
    const queue = new SerialQueue();
    const gate = deferred();
    let done = false;

    const running = queue.run(async () => {
      await gate.promise;
      done = true;
    });

    const drained = queue.drain().then(() => done);
    expect(done).toBe(false);

    gate.resolve();
    await running;
    await expect(drained).resolves.toBe(true);
  });

  test('drain resolves even when the queued task rejected', async () => {
    const queue = new SerialQueue();
    const failed = queue.run(async () => { throw new Error('boom'); });

    await expect(failed).rejects.toThrow('boom');
    await expect(queue.drain()).resolves.toBeUndefined();
  });
});
