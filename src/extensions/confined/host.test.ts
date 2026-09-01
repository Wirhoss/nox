import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { silentLogger } from '../../logger/logger';
import { confinementSupport } from '../confinement';
import { ExtensionCallError, ExtensionProcess, ExtensionProcessError } from './host';

import type { Spawned } from './host';
import type { ChildMessage, ChildPlan, HostMessage } from './protocol';

const ANSWERS = join(import.meta.dir, 'fixtures', 'answers.ts');

/**
 * The rejection itself, awaited.
 *
 * `expect(promise).rejects` reads better but does not settle before the test
 * body returns, and every test here releases its child in a `finally` — so the
 * unawaited assertion would race the shutdown and read the process error
 * instead of the one under test. That is not hypothetical: it is what these
 * tests did first, and they reported "exited with code 143".
 */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (cause) {
    if (cause instanceof Error) return cause;
    throw new Error(`Expected an Error, got ${String(cause)}.`, { cause });
  }
  throw new Error('Expected the call to reject, and it resolved.');
}

/**
 * The transport is exercised against a real second process, because that is the
 * part worth testing: a fake channel would prove the bookkeeping and nothing
 * about whether a call survives leaving this runtime.
 *
 * Unconfined, because these run wherever the suite runs and confinement is
 * Linux-only. What the kernel actually enforces is measured by
 * `scripts/probe-confinement.ts` inside the image; what is under test here is
 * that requests correlate, errors arrive as errors, and a dead child does not
 * leave a caller waiting forever.
 */
function started(): ExtensionProcess {
  return new ExtensionProcess({
    allowances: [],
    extensionId: 'test.answers',
    logger: silentLogger,
    runUnconfined: true,
  });
}

describe('ExtensionProcess', () => {
  test('carries a call to another process and back', async () => {
    const host = started();
    try {
      const exports = await host.load(ANSWERS);
      expect(exports).toEqual(['crash', 'echo', 'slowly', 'throws']);
      expect(await host.invoke('echo', { nested: [1, 'two'] })).toEqual({ nested: [1, 'two'] });
    } finally {
      await host.dispose();
    }
  });

  test('answers concurrent calls by their own ids, not in order', async () => {
    // The boundary is a pipe, not a call stack. A slow call must not be able to
    // collect a fast one's answer, which is the bug an id-less channel has.
    const host = started();
    try {
      await host.load(ANSWERS);
      const [slow, quick] = await Promise.all([
        host.invoke('slowly', 60),
        host.invoke('echo', 'immediate'),
      ]);
      expect(slow).toBe('waited 60');
      expect(quick).toBe('immediate');
    } finally {
      await host.dispose();
    }
  });

  test('carries a thrown error across with its name', async () => {
    const host = started();
    try {
      await host.load(ANSWERS);
      const failure = await rejection(host.invoke('throws', 'the extension said no'));
      expect(failure.message).toBe('the extension said no');
      expect(failure.name).toBe('DeliberateError');
      // The class does not survive, and recreating it is exactly the coupling
      // this boundary exists to remove.
      expect(failure).toBeInstanceOf(ExtensionCallError);
    } finally {
      await host.dispose();
    }
  });

  test('rejects a call for something the extension does not export', async () => {
    const host = started();
    try {
      await host.load(ANSWERS);
      const failure = await rejection(host.invoke('notThere'));
      expect(failure.message).toContain('no callable "notThere"');
    } finally {
      await host.dispose();
    }
  });

  test('rejects an in-flight call when the child dies under it', async () => {
    // Without this the symptom is a conversation that hangs, and the cause is
    // three layers away from where anyone would look.
    const host = started();
    try {
      await host.load(ANSWERS);
      const pending = rejection(host.invoke('slowly', 10_000));
      await rejection(host.invoke('crash'));
      const failure = await pending;
      expect(failure).toBeInstanceOf(ExtensionProcessError);
      expect(failure.message).toContain('test.answers');
    } finally {
      await host.dispose();
    }
  });

  test('refuses to call anything once released', async () => {
    const host = started();
    await host.load(ANSWERS);
    await host.dispose();
    expect((await rejection(host.invoke('echo', 1))).message).toContain('has been released');
    await host.dispose(); // Releasing twice is not an error.
  });
});

// ---------------------------------------------------------------------------
// The cases a real child cannot be made to produce on demand
// ---------------------------------------------------------------------------

interface Fake {
  readonly plan: ChildPlan;
  readonly sent: HostMessage[];
  emit(message: ChildMessage): void;
  exit(code: number): void;
  readonly killed: () => boolean;
}

function fakeChild(): { spawn: (plan: ChildPlan) => Spawned; state: () => Fake } {
  let captured: Fake | undefined;
  return {
    spawn: (plan: ChildPlan): Spawned => {
      const sent: HostMessage[] = [];
      let listener: ((message: ChildMessage) => void) | undefined;
      let killed = false;
      let settleExit: ((code: number) => void) | undefined;
      const exited = new Promise<number>((resolve) => {
        settleExit = resolve;
      });
      captured = {
        emit: (message) => listener?.(message),
        exit: (code) => settleExit?.(code),
        killed: () => killed,
        plan,
        sent,
      };
      return {
        child: {
          exited,
          kill: () => {
            killed = true;
            settleExit?.(-1);
          },
          send: (message) => sent.push(message),
        },
        onMessage: (next) => {
          listener = next;
        },
      };
    },
    state: () => {
      if (captured === undefined) throw new Error('Nothing was spawned.');
      return captured;
    },
  };
}

describe('ExtensionProcess confinement policy', () => {
  const detected = confinementSupport();

  test.skipIf(detected.available)('refuses to start where it cannot confine', () => {
    // The default is refusal, and the refusal names which half is missing —
    // because the two things an operator can do about it depend on knowing.
    const fake = fakeChild();
    expect(
      () =>
        new ExtensionProcess({
          allowances: [],
          extensionId: 'test.answers',
          logger: silentLogger,
          spawn: fake.spawn,
        }),
    ).toThrow(/cannot be confined/);
  });

  test.skipIf(detected.available)('warns on every start when told to run anyway', () => {
    const warnings: string[] = [];
    const fake = fakeChild();
    const host = new ExtensionProcess({
      allowances: [],
      extensionId: 'test.answers',
      logger: {
        ...silentLogger,
        warn: (_fields, message) => warnings.push(message),
      },
      runUnconfined: true,
      spawn: fake.spawn,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('without confinement');
    // What the child is told matches what the host decided.
    expect(fake.state().plan.confine).toBe(false);
    void host.dispose();
  });

  test('kills a child that will not leave when asked', async () => {
    const fake = fakeChild();
    const host = new ExtensionProcess({
      allowances: [],
      extensionId: 'test.answers',
      logger: silentLogger,
      runUnconfined: true,
      shutdownGraceMs: 20,
      spawn: fake.spawn,
    });
    await host.dispose();
    expect(fake.state().sent).toContainEqual({ kind: 'shutdown' });
    expect(fake.state().killed()).toBe(true);
  });

  test('leaves a child that does stop alone', async () => {
    const fake = fakeChild();
    const host = new ExtensionProcess({
      allowances: [],
      extensionId: 'test.answers',
      logger: silentLogger,
      runUnconfined: true,
      shutdownGraceMs: 5_000,
      spawn: fake.spawn,
    });
    const state = fake.state();
    const disposed = host.dispose();
    state.exit(0);
    await disposed;
    expect(state.killed()).toBe(false);
  });

  test('ignores a reply to a call nobody is waiting for', () => {
    // A late answer after a rejected call must not throw inside the message
    // handler, where there is no caller left to receive it.
    const fake = fakeChild();
    const host = new ExtensionProcess({
      allowances: [],
      extensionId: 'test.answers',
      logger: silentLogger,
      runUnconfined: true,
      spawn: fake.spawn,
    });
    expect(() => {
      fake.state().emit({ id: 'call-gone', kind: 'settled', value: 1 });
    }).not.toThrow();
    void host.dispose();
  });

  test('stamps a log line from the child with the extension that wrote it', () => {
    const lines: { fields: Record<string, unknown>; message: string }[] = [];
    const fake = fakeChild();
    const host = new ExtensionProcess({
      allowances: [],
      extensionId: 'test.answers',
      logger: {
        ...silentLogger,
        info: (fields, message) => lines.push({ fields: { ...fields }, message }),
      },
      runUnconfined: true,
      spawn: fake.spawn,
    });
    fake.state().emit({
      fields: { extensionId: 'nox.core', own: 1 },
      kind: 'log',
      level: 'info',
      message: 'from inside',
    });
    // The extension named someone else and did not get to keep it.
    expect(lines).toEqual([
      { fields: { extensionId: 'test.answers', own: 1 }, message: 'from inside' },
    ]);
    void host.dispose();
  });
});
