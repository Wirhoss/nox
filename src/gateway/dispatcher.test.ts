import { describe, expect, test } from 'bun:test';

import { EventLog } from '../utils';

import { SessionDispatcher } from './dispatcher';

import type { AgentStreamEvent } from '../agent/runner';
import type { PendingEscalation } from '../gate';
import type { Message } from '../provider';
import type { GatewaySession } from './dispatcher';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeSession implements GatewaySession {
  public readonly log = new EventLog<AgentStreamEvent>();
  public runs: string[] = [];
  public steers: string[] = [];
  public runDelayMs = 0;

  private running = false;
  private idlePromise: Promise<void> = Promise.resolve();
  private idleResolve?: () => void;

  public get eventCursor(): number { return this.log.length; }
  public get history(): readonly Message[] { return []; }
  public get idle(): Promise<void> { return this.idlePromise; }
  public get isRunning(): boolean { return this.running; }

  public resolvePermission(_requestId: string, _approved: boolean): boolean { return false; }

  public async abort(): Promise<boolean> {
    const wasRunning = this.running;
    this.finish();
    return wasRunning;
  }

  public listPendingPermissions(): PendingEscalation[] { return []; }

  public async run(text: string): Promise<void> {
    if (this.running) throw new Error('Agent is already running');
    this.runs.push(text);
    if (text === 'fail') throw new Error('boom');
    this.begin();
    await sleep(this.runDelayMs);
    this.finish();
  }

  public async steer(text: string): Promise<void> {
    this.steers.push(text);
    this.finish();
    this.begin();
    await sleep(this.runDelayMs);
    this.finish();
  }

  public subscribeToEvents(from = 0): AsyncGenerator<AgentStreamEvent> {
    return this.log.subscribe(from);
  }

  private begin(): void {
    this.running = true;
    this.idlePromise = new Promise((resolve) => { this.idleResolve = resolve; });
  }

  private finish(): void {
    if (!this.running) return;
    this.running = false;
    this.idleResolve?.();
  }
}

function setup(debounceMs = 10) {
  const session = new FakeSession();
  const errors: Error[] = [];
  const dispatcher = new SessionDispatcher(session, (error) => errors.push(error), debounceMs);
  return { dispatcher, errors, session };
}

describe('SessionDispatcher', () => {
  test('rapid messages batch into a single run', async () => {
    const { dispatcher, session } = setup();

    expect(dispatcher.submit('a')).toBe('queued');
    expect(dispatcher.submit('b')).toBe('queued');
    await sleep(40);

    expect(session.runs).toEqual(['a\nb']);
  });

  test('messages arriving mid-run wait and batch for the next run', async () => {
    const { dispatcher, session } = setup();
    session.runDelayMs = 60;

    dispatcher.submit('a');
    await sleep(20);
    expect(session.isRunning).toBe(true);
    dispatcher.submit('b');
    dispatcher.submit('c');
    await sleep(150);

    expect(session.runs).toEqual(['a', 'b\nc']);
  });

  test('steer while running bypasses the queue', async () => {
    const { dispatcher, session } = setup();
    session.runDelayMs = 60;

    dispatcher.submit('a');
    await sleep(20);
    expect(dispatcher.submit('change of plans', true)).toBe('steered');
    await sleep(100);

    expect(session.steers).toEqual(['change of plans']);
  });

  test('steer while idle falls back to a queued run', async () => {
    const { dispatcher, session } = setup();

    expect(dispatcher.submit('x', true)).toBe('queued');
    await sleep(40);

    expect(session.runs).toEqual(['x']);
    expect(session.steers).toEqual([]);
  });

  test('a failed run is reported and does not kill the queue', async () => {
    const { dispatcher, errors, session } = setup();

    dispatcher.submit('fail');
    await sleep(30);
    dispatcher.submit('ok');
    await sleep(30);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('boom');
    expect(session.runs).toEqual(['fail', 'ok']);
  });
});
