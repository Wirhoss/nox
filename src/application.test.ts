import { describe, expect, test } from 'bun:test';

import { NoxApplication } from './application';
import { createContributionPoint } from './extensions/contribution';
import {
  DuplicateExtensionError,
  ExtensionActivationError,
  ExtensionCompatibilityError,
} from './extensions/error';
import { defineExtension, type NoxExtension } from './extensions/extension';
import { createServiceToken } from './extensions/service';

interface Greeter {
  greet(): string;
}

const greeters = createContributionPoint<Greeter>('nox.greeters');
const clockService = createServiceToken<{ now(): number }>('nox.clock');

/** Records its lifecycle into a shared log so ordering is observable. */
function tracer(id: string, order: string[]): NoxExtension {
  return defineExtension({
    manifest: { engines: { nox: '*' }, id },
    activate(context) {
      order.push(`activate:${id}`);
      context.subscriptions.add({
        dispose() {
          order.push(`dispose:${id}`);
        },
      });
    },
    deactivate() {
      order.push(`deactivate:${id}`);
    },
  });
}

describe('NoxApplication', () => {
  test('activates in registration order and tears down in reverse', async () => {
    const order: string[] = [];
    const app = new NoxApplication({
      extensions: [tracer('nox.first', order), tracer('nox.second', order)],
    });

    await app.start();
    expect(app.state).toBe('running');
    await app.stop();

    expect(order).toEqual([
      'activate:nox.first',
      'activate:nox.second',
      'deactivate:nox.second',
      'deactivate:nox.first',
      'dispose:nox.second',
      'dispose:nox.first',
    ]);
    expect(app.state).toBe('stopped');
  });

  test('a contribution is readable through the application and gone after stop', async () => {
    const app = new NoxApplication({
      extensions: [
        defineExtension({
          manifest: { engines: { nox: '*' }, id: 'nox.hello' },
          activate(context) {
            context.contributions.register(greeters, 'english', { greet: () => 'hello' });
          },
        }),
      ],
    });

    await app.start();
    expect(app.contributions.get(greeters, 'english')?.value.greet()).toBe('hello');
    expect(app.contributions.get(greeters, 'english')?.extensionId).toBe('nox.hello');

    await app.stop();
    expect(app.contributions.has(greeters, 'english')).toBe(false);
  });

  test('hands extensions the host services and its own identity', async () => {
    let seen: undefined | { id: string; now: number };
    const app = new NoxApplication().provide(clockService, { now: () => 7 });

    app.register(
      defineExtension({
        manifest: { engines: { nox: '*' }, id: 'nox.reader' },
        activate(context) {
          seen = { id: context.extension.id, now: context.services.get(clockService).now() };
        },
      }),
    );
    await app.start();

    expect(seen).toEqual({ id: 'nox.reader', now: 7 });
  });

  test('aborts the application signal before extension cleanup starts', async () => {
    let abortedDuringDispose: boolean | undefined;
    const app = new NoxApplication({
      extensions: [
        defineExtension({
          manifest: { engines: { nox: '*' }, id: 'nox.watcher' },
          activate(context) {
            expect(context.signal.aborted).toBe(false);
            context.subscriptions.add({
              dispose() {
                abortedDuringDispose = context.signal.aborted;
              },
            });
          },
        }),
      ],
    });

    await app.start();
    await app.stop();

    expect(abortedDuringDispose).toBe(true);
  });

  test('refuses an extension ID that is already registered', () => {
    const order: string[] = [];
    const app = new NoxApplication({ extensions: [tracer('nox.only', order)] });

    expect(() => app.register(tracer('nox.only', order))).toThrow(DuplicateExtensionError);
  });

  test('wraps an activation failure, and stop still releases what activated', async () => {
    const order: string[] = [];
    const app = new NoxApplication({
      extensions: [
        tracer('nox.good', order),
        defineExtension({
          manifest: { engines: { nox: '*' }, id: 'nox.broken' },
          activate() {
            throw new Error('missing credentials');
          },
        }),
      ],
    });

    const failure: unknown = await app.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExtensionActivationError);
    expect((failure as ExtensionActivationError).extensionId).toBe('nox.broken');
    expect((failure as ExtensionActivationError).cause).toBeInstanceOf(Error);

    await app.stop();
    expect(order).toEqual(['activate:nox.good', 'deactivate:nox.good', 'dispose:nox.good']);
  });

  test('refuses to start an extension that does not accept this runtime', async () => {
    const order: string[] = [];
    const app = new NoxApplication({
      noxVersion: '0.2.0',
      extensions: [
        tracer('nox.fine', order),
        defineExtension({
          manifest: { engines: { nox: '^0.1.0' }, id: 'nox.stale' },
          activate() {
            order.push('activate:nox.stale');
          },
        }),
      ],
    });

    const failure: unknown = await app.start().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ExtensionCompatibilityError);
    expect((failure as ExtensionCompatibilityError).extensionId).toBe('nox.stale');
    expect((failure as ExtensionCompatibilityError).required).toBe('^0.1.0');
    expect((failure as ExtensionCompatibilityError).noxVersion).toBe('0.2.0');
    // Checked before anything ran: the compatible extension never activated either.
    expect(order).toEqual([]);
  });

  test('accepts an extension whose range covers this runtime, prereleases included', async () => {
    const order: string[] = [];
    const app = new NoxApplication({
      noxVersion: '0.2.1-rc.1',
      extensions: [
        defineExtension({
          manifest: { engines: { nox: '^0.2.0' }, id: 'nox.current' },
          activate() {
            order.push('activate:nox.current');
          },
        }),
      ],
    });

    await app.start();

    expect(order).toEqual(['activate:nox.current']);
    expect(app.noxVersion).toBe('0.2.1-rc.1');
  });

  test('refuses a runtime version that is not a version', () => {
    expect(() => new NoxApplication({ noxVersion: 'latest' })).toThrow(TypeError);
  });

  test('is configurable only before it starts, and stops idempotently', async () => {
    const order: string[] = [];
    const app = new NoxApplication({ extensions: [tracer('nox.only', order)] });
    await app.start();

    expect(() => app.register(tracer('nox.late', order))).toThrow('while Nox is running');
    expect(() => app.provide(clockService, { now: () => 0 })).toThrow('while Nox is running');
    const restart: unknown = await app.start().catch((error: unknown) => error);
    expect(restart).toBeInstanceOf(Error);
    expect((restart as Error).message).toBe('Nox cannot start while it is running.');

    await app.stop();
    await app.stop();

    expect(order.filter((entry) => entry === 'dispose:nox.only')).toHaveLength(1);
  });
});
