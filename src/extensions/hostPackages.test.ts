import { EXTENSION_EXTERNAL_PACKAGES, HOST_PROVIDED_PACKAGES } from '@nox/extension-api';
import { describe, expect, test } from 'bun:test';

import { hostPackageVersions, unsatisfiedHostPackages } from './hostPackages';

describe('the packages the host provides', () => {
  // The list is a promise made to extensions that compile elsewhere: they leave
  // these external and expect Nox to have them. A name that stopped resolving
  // used to be found by an extension failing to start, which is both later and
  // somebody else's problem.
  test('every declared package actually resolves', () => {
    const installed = hostPackageVersions();

    expect([...installed.keys()].sort()).toEqual([...HOST_PROVIDED_PACKAGES].sort());
  });

  test('an extension bundle also leaves the contract package external', () => {
    expect(EXTENSION_EXTERNAL_PACKAGES).toEqual([...HOST_PROVIDED_PACKAGES, '@nox/extension-api']);
  });
});

describe('checking what an extension declared', () => {
  test('says nothing when a package declares nothing', () => {
    expect(unsatisfiedHostPackages(undefined)).toBeUndefined();
    expect(unsatisfiedHostPackages({})).toBeUndefined();
  });

  test('accepts a range the installed version satisfies', () => {
    const installed = hostPackageVersions().get('zod');

    expect(unsatisfiedHostPackages({ zod: `^${installed ?? '0.0.0'}` })).toBeUndefined();
  });

  test('names both versions when the range does not match', () => {
    const problem = unsatisfiedHostPackages({ zod: '^2.0.0' });

    expect(problem).toContain('zod ^2.0.0 is required');
    expect(problem).toContain(hostPackageVersions().get('zod') ?? 'unresolvable');
  });

  test('reports a package this Nox does not provide at all', () => {
    expect(unsatisfiedHostPackages({ 'left-pad': '^1.0.0' })).toBe(
      'left-pad is not provided by this Nox',
    );
  });

  test('reports every unmet package, not the first one', () => {
    const problem = unsatisfiedHostPackages({ 'left-pad': '^1.0.0', zod: '^2.0.0' });

    expect(problem).toContain('left-pad');
    expect(problem).toContain('zod');
  });
});
