import { createServiceToken } from '@nox/extension-api';
import { describe, expect, test } from 'bun:test';

import {
  DuplicateServiceError,
  MissingServiceError,
  RestrictedServiceError,
  UndeclaredServiceError,
} from './error';
import { ServiceCollection } from './service';

interface Clock {
  now(): number;
}

const clockService = createServiceToken<Clock>('nox.clock');
const secretsService = createServiceToken<Clock>('nox.secret-store');
const adminService = createServiceToken<Clock>('nox.config-admin', { controlPlane: true });

describe('createServiceToken', () => {
  test('rejects an identifier that is not package-like', () => {
    expect(() => createServiceToken<Clock>('Nox Clock')).toThrow(TypeError);
  });
});

describe('ServiceCollection', () => {
  test('resolves a provided service by token', () => {
    const services = new ServiceCollection().provide(clockService, { now: () => 42 });

    expect(services.has(clockService)).toBe(true);
    expect(services.get(clockService).now()).toBe(42);
    expect(services.tryGet(clockService)?.now()).toBe(42);
  });

  test('throws for a service nobody provided, and tryGet does not', () => {
    const services = new ServiceCollection();

    expect(() => services.get(clockService)).toThrow(MissingServiceError);
    expect(services.tryGet(clockService)).toBeUndefined();
  });

  test('refuses a token that is already provided', () => {
    const services = new ServiceCollection().provide(clockService, { now: () => 1 });

    expect(() => services.provide(clockService, { now: () => 2 })).toThrow(DuplicateServiceError);
  });

  test('refuses new services once locked, so extensions never see a moving set', () => {
    const services = new ServiceCollection();
    services.lock();

    expect(() => services.provide(clockService, { now: () => 1 })).toThrow(
      'Services cannot be changed after extension activation has started.',
    );
  });
});

describe('a scoped view of the services', () => {
  test('resolves exactly what the manifest declared', () => {
    const services = new ServiceCollection().provide(clockService, { now: () => 42 });

    const scoped = services.scoped('nox.reader', ['nox.clock']);

    expect(scoped.has(clockService)).toBe(true);
    expect(scoped.get(clockService).now()).toBe(42);
    expect(scoped.tryGet(clockService)?.now()).toBe(42);
  });

  test('refuses a running service the manifest never asked for', () => {
    const services = new ServiceCollection()
      .provide(clockService, { now: () => 42 })
      .provide(secretsService, { now: () => 0 });

    const scoped = services.scoped('nox.reader', ['nox.clock']);

    expect(() => scoped.get(secretsService)).toThrow(UndeclaredServiceError);
  });

  // The undeclared answer is never a soft one: an extension that asked without
  // declaring has a bug in its manifest, and `undefined` would hide it behind a
  // capability that silently stops running.
  test('refuses through tryGet and has as well, not only get', () => {
    const services = new ServiceCollection().provide(secretsService, { now: () => 0 });

    const scoped = services.scoped('nox.reader', []);

    expect(() => scoped.tryGet(secretsService)).toThrow(UndeclaredServiceError);
    expect(() => scoped.has(secretsService)).toThrow(UndeclaredServiceError);
  });

  test('declaring nothing grants nothing', () => {
    const services = new ServiceCollection().provide(clockService, { now: () => 42 });

    expect(() => services.scoped('nox.reader').get(clockService)).toThrow(UndeclaredServiceError);
  });

  // A declaration is a request, not a promise the host made: an operator who
  // has not configured the service should see it missing, not undeclared.
  test('a declared service that nobody provided is still missing, not undeclared', () => {
    const scoped = new ServiceCollection().scoped('nox.reader', ['nox.clock']);

    expect(() => scoped.get(clockService)).toThrow(MissingServiceError);
    expect(scoped.tryGet(clockService)).toBeUndefined();
    expect(scoped.has(clockService)).toBe(false);
  });

  test('names the extension and the service, so the fix is the message', () => {
    const scoped = new ServiceCollection().scoped('nox.reader', []);

    expect(() => scoped.get(clockService)).toThrow(
      'Extension "nox.reader" requested service "nox.clock", which its manifest does not declare.',
    );
  });
});

describe('what an origin entitles a package to', () => {
  test('a builtin holds a control-plane service it declared', () => {
    const services = new ServiceCollection().provide(adminService, { now: () => 1 });

    const scoped = services.scoped('nox.toolset.config', ['nox.config-admin'], 'builtin');

    expect(scoped.get(adminService).now()).toBe(1);
  });

  // Declaring it is not the missing piece, so the error must not say it is: an
  // author told "undeclared" edits the manifest, and the manifest cannot help.
  test('an installed package cannot hold one however loudly it asks', () => {
    const services = new ServiceCollection().provide(adminService, { now: () => 1 });

    const scoped = services.scoped('acme.tools', ['nox.config-admin'], 'installed');

    expect(() => scoped.get(adminService)).toThrow(RestrictedServiceError);
    expect(() => scoped.get(adminService)).toThrow(/reserved to Nox builtins/u);
  });

  test('the restriction outranks the declaration check, and covers every question', () => {
    const services = new ServiceCollection().provide(adminService, { now: () => 1 });

    const scoped = services.scoped('acme.tools', [], 'installed');

    expect(() => scoped.get(adminService)).toThrow(RestrictedServiceError);
    expect(() => scoped.tryGet(adminService)).toThrow(RestrictedServiceError);
    expect(() => scoped.has(adminService)).toThrow(RestrictedServiceError);
  });

  test('an ordinary service is unaffected by origin', () => {
    const services = new ServiceCollection().provide(clockService, { now: () => 42 });

    const scoped = services.scoped('acme.tools', ['nox.clock'], 'installed');

    expect(scoped.get(clockService).now()).toBe(42);
  });

  test('an installed package is still refused a service it did not declare', () => {
    const services = new ServiceCollection().provide(secretsService, { now: () => 0 });

    expect(() => services.scoped('acme.tools', [], 'installed').get(secretsService)).toThrow(
      UndeclaredServiceError,
    );
  });
});
