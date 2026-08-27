import { createServiceToken } from '@nox/extension-api';
import { describe, expect, test } from 'bun:test';

import { DuplicateServiceError, MissingServiceError } from './error';
import { ServiceCollection } from './service';

interface Clock {
  now(): number;
}

const clockService = createServiceToken<Clock>('nox.clock');

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
