import { describe, expect, test } from 'bun:test';

import { EventLog } from './eventLog';

/** Collects until the log closes, so the assertion is on a finished stream. */
async function collect<T>(events: AsyncGenerator<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

/** Collects a fixed count, for streams that are never closed. */
async function take<T>(events: AsyncGenerator<T>, count: number): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) {
    collected.push(event);
    if (collected.length === count) break;
  }
  return collected;
}

describe('EventLog', () => {
  test('records pushes in order', () => {
    const log = new EventLog<string>();

    log.push('a');
    log.push('b');

    expect(log.length).toBe(2);
    expect(log.snapshot()).toEqual(['a', 'b']);
  });

  test('notifies onPush with the cursor the event landed on', () => {
    const seen: [string, number][] = [];
    const log = new EventLog<string>((event, cursor) => seen.push([event, cursor]));

    log.push('a');
    log.push('b');

    expect(seen).toEqual([
      ['a', 0],
      ['b', 1],
    ]);
  });

  test('a subscriber replays what it missed and then follows along', async () => {
    const log = new EventLog<string>();
    log.push('before');

    const collected = take(log.subscribe(), 3);
    log.push('during');
    log.push('after');

    expect(await collected).toEqual(['before', 'during', 'after']);
  });

  test('subscribing from a cursor skips everything before it', async () => {
    const log = new EventLog<string>();
    log.push('a');
    log.push('b');
    log.push('c');
    log.close();

    expect(await collect(log.subscribe(1))).toEqual(['b', 'c']);
  });

  test('every subscriber gets every event', async () => {
    const log = new EventLog<string>();
    const first = collect(log.subscribe());
    const second = collect(log.subscribe());

    log.push('a');
    log.push('b');
    log.close();

    expect(await first).toEqual(['a', 'b']);
    expect(await second).toEqual(['a', 'b']);
  });

  test('closing ends a subscription that is waiting for more', async () => {
    const log = new EventLog<string>();
    const collected = collect(log.subscribe());

    log.push('a');
    log.close();

    expect(await collected).toEqual(['a']);
    expect(log.isClosed).toBe(true);
  });

  test('a subscriber attaching after close still replays, then ends', async () => {
    const log = new EventLog<string>();
    log.push('a');
    log.close();

    expect(await collect(log.subscribe())).toEqual(['a']);
  });

  test('closing twice is harmless', () => {
    const log = new EventLog<string>();

    log.close();
    log.close();

    expect(log.isClosed).toBe(true);
  });

  test('pushing to a closed log throws', () => {
    const log = new EventLog<string>();
    log.close();

    expect(() => {
      log.push('a');
    }).toThrow('Cannot push to a closed event log.');
  });

  test('a snapshot is frozen and does not track later pushes', () => {
    const log = new EventLog<string>();
    log.push('a');

    const snapshot = log.snapshot();
    log.push('b');

    expect(snapshot).toEqual(['a']);
    expect(() => (snapshot as string[]).push('c')).toThrow(TypeError);
  });
});
