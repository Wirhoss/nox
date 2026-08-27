import { createContributionPoint } from '@nox/extension-api';
import { describe, expect, test } from 'bun:test';

import { ContributionRegistry } from './contribution';
import { DisposableStore } from './disposable';
import { DuplicateContributionError } from './error';

interface Greeter {
  greet(): string;
}

const greeters = createContributionPoint<Greeter>('nox.greeters');

describe('createContributionPoint', () => {
  test('rejects an identifier that is not package-like', () => {
    expect(() => createContributionPoint<Greeter>('Nox Greeters')).toThrow(TypeError);
  });
});

describe('ContributionRegistry', () => {
  test('attributes every contribution to the extension that registered it', () => {
    const registry = new ContributionRegistry();
    const resources = new DisposableStore();

    registry.scoped('nox.hello', resources).register(greeters, 'english', {
      greet: () => 'hello',
    });

    expect(registry.get(greeters, 'english')?.extensionId).toBe('nox.hello');
    expect(registry.get(greeters, 'english')?.value.greet()).toBe('hello');
    expect(registry.has(greeters, 'english')).toBe(true);
    expect(registry.list(greeters)).toHaveLength(1);
  });

  test('refuses a contribution ID already taken at the same point', () => {
    const registry = new ContributionRegistry();
    const first = registry.scoped('nox.first', new DisposableStore());
    const second = registry.scoped('nox.second', new DisposableStore());

    first.register(greeters, 'english', { greet: () => 'hello' });

    expect(() => second.register(greeters, 'english', { greet: () => 'hi' })).toThrow(
      DuplicateContributionError,
    );
  });

  test('disposing an extension removes only what that extension contributed', async () => {
    const registry = new ContributionRegistry();
    const helloResources = new DisposableStore();

    registry.scoped('nox.hello', helloResources).register(greeters, 'english', {
      greet: () => 'hello',
    });
    registry.scoped('nox.bonjour', new DisposableStore()).register(greeters, 'french', {
      greet: () => 'bonjour',
    });

    await helloResources.dispose();

    expect(registry.has(greeters, 'english')).toBe(false);
    expect(registry.has(greeters, 'french')).toBe(true);
  });

  test('a disposal never evicts a contribution that replaced it', async () => {
    const registry = new ContributionRegistry();
    const resources = new DisposableStore();
    const extensions = registry.scoped('nox.hello', resources);

    extensions.register(greeters, 'english', { greet: () => 'first' });
    await resources.dispose();

    const replacement = new DisposableStore();
    registry.scoped('nox.other', replacement).register(greeters, 'english', {
      greet: () => 'second',
    });
    await resources.dispose();

    expect(registry.get(greeters, 'english')?.value.greet()).toBe('second');
  });

  test('an unknown point reads as empty rather than throwing', () => {
    const registry = new ContributionRegistry();
    const unused = createContributionPoint<Greeter>('nox.unused');

    expect(registry.list(unused)).toEqual([]);
    expect(registry.get(unused, 'english')).toBeUndefined();
    expect(registry.has(unused, 'english')).toBe(false);
  });
});
