import { describe, expect, test } from 'bun:test';

import { Mutex } from './mutex';

/** Resolves with the error a promise rejected with, or throws if it resolved. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new TypeError(`Expected an Error, got ${typeof error}.`, { cause: error });
  }
  throw new Error('Expected the promise to reject, but it resolved.');
}

describe('Mutex', () => {
  test('runs tasks in submission order without interleaving', async () => {
    const mutex = new Mutex();
    const events: string[] = [];

    const tasks = [1, 2, 3].map(async (id) =>
      mutex.run(async () => {
        events.push(`start:${String(id)}`);
        await Promise.resolve();
        await Promise.resolve();
        events.push(`end:${String(id)}`);
      }),
    );
    await Promise.all(tasks);

    expect(events).toEqual(['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3']);
  });

  test('a rejected task does not poison the ones queued behind it', async () => {
    const mutex = new Mutex();

    const failure = await rejection(
      mutex.run(() => {
        throw new Error('boom');
      }),
    );
    expect(failure.message).toBe('boom');
    expect(await mutex.run(() => 'ok')).toBe('ok');
  });

  test('idle resolves once the queued tasks have settled', async () => {
    const mutex = new Mutex();
    const events: string[] = [];

    void mutex.run(async () => {
      await Promise.resolve();
      events.push('first');
    });
    void mutex
      .run(() => {
        throw new Error('boom');
      })
      .catch(() => undefined);
    void mutex.run(() => {
      events.push('third');
    });

    await mutex.idle;

    expect(events).toEqual(['first', 'third']);
  });
});
