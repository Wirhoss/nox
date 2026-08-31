import { createContributionPoint, createServiceToken, defineExtension } from '@nox/extension-api';
import { describe, expect, test } from 'bun:test';

import { NoxApplication } from './application';
import {
  DuplicateExtensionError,
  ExtensionActivationError,
  ExtensionCompatibilityError,
} from './extensions/error';

import type { Agent, OpenSessionOptions } from './agent/agent';
import type { RunnerState } from './agent/runner';
import type { Session } from './agent/session';
import type { NoxExtension } from './extensions/extension';

interface Greeter {
  greet(): string;
}

/** Only what the application actually touches on a session it is holding. */
interface FakeSession {
  sessionId: string;
  state: RunnerState;
  stop(): Promise<void>;
}

const greeters = createContributionPoint<Greeter>('nox.greeters');
const clockService = createServiceToken<{ now(): number }>('nox.clock');

function stubSession(sessionId: string, order: string[]): FakeSession {
  const session: FakeSession = {
    sessionId,
    state: 'idle',
    stop(): Promise<void> {
      session.state = 'stopped';
      order.push(`stop:${sessionId}`);
      return Promise.resolve();
    },
  };
  return session;
}

/** An agent that hands out sessions without a provider or a database behind it. */
function stubAgent(agentId: string, order: string[]): Agent {
  let opened = 0;

  return {
    agentId,
    openSession(options: OpenSessionOptions = {}): Promise<Session> {
      opened += 1;
      const session = stubSession(options.sessionId ?? `session-${String(opened)}`, order);
      return Promise.resolve(session as unknown as Session);
    },
  } as unknown as Agent;
}

/** Records its lifecycle into a shared log so ordering is observable. */
function tracer(id: string, order: string[]): NoxExtension {
  return defineExtension({
    manifest: {
      engines: { extensionApi: '*', nox: '*' },
      id,
      main: 'embedded.js',
      schemaVersion: 1,
      version: '0.0.0',
    },
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
          manifest: {
            engines: { extensionApi: '*', nox: '*' },
            id: 'nox.hello',
            main: 'embedded.js',
            schemaVersion: 1,
            version: '0.0.0',
          },
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
        manifest: {
          engines: { extensionApi: '*', nox: '*' },
          id: 'nox.reader',
          main: 'embedded.js',
          schemaVersion: 1,
          services: ['nox.clock'],
          version: '0.0.0',
        },
        activate(context) {
          seen = { id: context.extension.id, now: context.services.get(clockService).now() };
        },
      }),
    );
    await app.start();

    expect(seen).toEqual({ id: 'nox.reader', now: 7 });
  });

  // The container an extension holds is its own view, not the host's registry:
  // what it can reach is fixed by its manifest before it runs, so an installed
  // package cannot widen its own reach by knowing a token ID.
  test('fails activation when an extension reaches past what it declared', () => {
    const app = new NoxApplication().provide(clockService, { now: () => 7 });

    app.register(
      defineExtension({
        manifest: {
          engines: { extensionApi: '*', nox: '*' },
          id: 'nox.greedy',
          main: 'embedded.js',
          schemaVersion: 1,
          version: '0.0.0',
        },
        activate(context) {
          context.services.get(clockService);
        },
      }),
    );

    expect(app.start()).rejects.toThrow(ExtensionActivationError);
  });

  test('aborts the application signal before extension cleanup starts', async () => {
    let abortedDuringDispose: boolean | undefined;
    const app = new NoxApplication({
      extensions: [
        defineExtension({
          manifest: {
            engines: { extensionApi: '*', nox: '*' },
            id: 'nox.watcher',
            main: 'embedded.js',
            schemaVersion: 1,
            version: '0.0.0',
          },
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
          manifest: {
            engines: { extensionApi: '*', nox: '*' },
            id: 'nox.broken',
            main: 'embedded.js',
            schemaVersion: 1,
            version: '0.0.0',
          },
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
          manifest: {
            engines: { extensionApi: '*', nox: '^0.1.0' },
            id: 'nox.stale',
            main: 'embedded.js',
            schemaVersion: 1,
            version: '0.0.0',
          },
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
          manifest: {
            engines: { extensionApi: '*', nox: '^0.2.0' },
            id: 'nox.current',
            main: 'embedded.js',
            schemaVersion: 1,
            version: '0.0.0',
          },
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

describe('NoxApplication agents and sessions', () => {
  test('lists registered agents, sorted, and refuses a duplicate id', () => {
    const order: string[] = [];
    const app = new NoxApplication().addAgent(stubAgent('writer', order));
    app.addAgent(stubAgent('analyst', order));

    expect(app.agentIds).toEqual(['analyst', 'writer']);
    expect(app.getAgent('writer')).toBeDefined();
    expect(app.getAgent('missing')).toBeUndefined();
    expect(() => app.addAgent(stubAgent('writer', order))).toThrow('already registered');
  });

  test('reports itself busy only while a session is inside a run', async () => {
    const order: string[] = [];
    const app = new NoxApplication().addAgent(stubAgent('writer', order));
    await app.start();

    const idle = (await app.openSession('writer', { sessionId: 'a' })) as unknown as FakeSession;
    // An open conversation nobody is talking in is exactly when background work
    // should run, so holding a session is not on its own being busy.
    expect(app.busy()).toBe(false);

    idle.state = 'running';
    expect(app.busy()).toBe(true);

    idle.state = 'idle';
    expect(app.busy()).toBe(false);

    // A session that stopped without being closed drops out rather than
    // leaving the runtime looking permanently occupied.
    idle.state = 'running';
    expect(app.busy()).toBe(true);
    await idle.stop();
    expect(app.busy()).toBe(false);
  });

  test('holds the sessions it opened and drops them when they are closed', async () => {
    const order: string[] = [];
    const app = new NoxApplication().addAgent(stubAgent('writer', order));
    await app.start();

    const first = await app.openSession('writer', { sessionId: 'a' });
    await app.openSession('writer', { sessionId: 'b' });

    expect(app.sessions.map((live) => live.session.sessionId)).toEqual(['a', 'b']);
    expect(app.sessions.every((live) => live.agentId === 'writer')).toBe(true);

    expect(await app.closeSession(first.sessionId)).toBe(true);
    expect(await app.closeSession(first.sessionId)).toBe(false);
    expect(app.sessions.map((live) => live.session.sessionId)).toEqual(['b']);
    expect(order).toEqual(['stop:a']);
  });

  test('a session stopped through its own handle is no longer running', async () => {
    const order: string[] = [];
    const app = new NoxApplication().addAgent(stubAgent('writer', order));
    await app.start();

    const session = await app.openSession('writer', { sessionId: 'a' });
    expect(app.sessions).toHaveLength(1);

    await session.stop();

    expect(app.sessions).toEqual([]);
  });

  test('refuses to open a session for an unknown agent, or while not running', async () => {
    const order: string[] = [];
    const app = new NoxApplication().addAgent(stubAgent('writer', order));

    const beforeStart: unknown = await app.openSession('writer').catch((error: unknown) => error);
    expect((beforeStart as Error).message).toBe('Nox cannot open a session while it is created.');

    await app.start();
    const unknownAgent: unknown = await app.openSession('ghost').catch((error: unknown) => error);
    expect((unknownAgent as Error).message).toBe('No agent is registered as ghost.');

    await app.stop();
    const afterStop: unknown = await app.openSession('writer').catch((error: unknown) => error);
    expect((afterStop as Error).message).toBe('Nox cannot open a session while it is stopped.');
  });

  test('shutdown ends conversations, then extensions, then what it was given to own', async () => {
    const order: string[] = [];
    const app = new NoxApplication({ extensions: [tracer('nox.only', order)] });
    app.addAgent(stubAgent('writer', order));
    app.own({
      dispose() {
        order.push('dispose:storage');
      },
    });

    await app.start();
    await app.openSession('writer', { sessionId: 'a' });
    await app.stop();

    expect(order).toEqual([
      'activate:nox.only',
      'stop:a',
      'deactivate:nox.only',
      'dispose:nox.only',
      'dispose:storage',
    ]);
    expect(app.sessions).toEqual([]);
  });

  test('refuses ownership of a resource once it has started, and agents once stopped', async () => {
    const order: string[] = [];
    const app = new NoxApplication().addAgent(stubAgent('writer', order));
    await app.start();

    expect(() =>
      app.own({
        dispose() {
          order.push('dispose:never');
        },
      }),
    ).toThrow('while Nox is running');

    await app.stop();
    expect(() => app.addAgent(stubAgent('late', order))).toThrow('while Nox is stopped');
  });
});
