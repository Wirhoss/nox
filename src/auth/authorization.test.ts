import { describe, expect, test } from 'bun:test';

import { testCatalog, testPrincipal } from '../testFixtures';
import { AuthorityCatalog } from './authority';
import { authorize, GrantAuthorizationProvider, OwnerAuthorizationProvider } from './authorization';
import { CORE_AUTHORITIES } from './coreAuthorities';

import type { AuthorizationProvider, AuthorizationRequest } from './authorization';

const CATALOG = testCatalog('nox.files.read', 'nox.files.write');

function request(overrides: Partial<AuthorizationRequest> = {}): AuthorizationRequest {
  return {
    authority: 'nox.files.read',
    principal: testPrincipal('alice'),
    runId: 'run-1',
    sessionId: 'session-1',
    toolName: 'read_file',
    toolSetId: 'files',
    trackId: 'track-1',
    ...overrides,
  };
}

describe('OwnerAuthorizationProvider', () => {
  const provider = new OwnerAuthorizationProvider('web');

  test('gives the authenticated owner every registered authority', () => {
    expect(
      provider.authorize(request({ principal: { issuer: 'web', subject: 'account-1' } })),
    ).toMatchObject({
      allowed: true,
      matchedGrant: '*',
    });
  });

  test('still rejects a principal vouched for by another transport', () => {
    expect(provider.authorize(request())).toMatchObject({ allowed: false });
  });
});

describe('GrantAuthorizationProvider', () => {
  const provider = new GrantAuthorizationProvider(
    'test-broker',
    { alice: ['nox.files.read'], root: ['*'] },
    CATALOG,
  );

  test('allows a granted authority and names the entry that matched', async () => {
    expect(await provider.authorize(request())).toMatchObject({
      allowed: true,
      matchedGrant: 'nox.files.read',
    });
    expect(
      await provider.authorize(
        request({ authority: 'nox.files.write', principal: testPrincipal('root') }),
      ),
    ).toMatchObject({ allowed: true, matchedGrant: '*' });
  });

  test('denies an authority the principal was not granted', async () => {
    expect(await provider.authorize(request({ authority: 'nox.files.write' }))).toMatchObject({
      allowed: false,
    });
  });

  test('denies a principal with no grants at all', async () => {
    const decision = await provider.authorize(request({ principal: testPrincipal('stranger') }));

    expect(decision.allowed).toBeFalse();
    expect(decision.reason).toContain('no grants configured');
  });

  test('denies a principal issued by another transport', async () => {
    // The same subject on a different broker is a different person.
    const decision = await provider.authorize(
      request({ principal: { issuer: 'other-broker', subject: 'alice' } }),
    );

    expect(decision.allowed).toBeFalse();
    expect(decision.reason).toContain('not issued by');
  });

  test('refuses to load a grant naming an authority nothing registered', () => {
    expect(
      () => new GrantAuthorizationProvider('test-broker', { alice: ['nox.files.delete'] }, CATALOG),
    ).toThrow('which nothing registered');
  });
});

describe('authorize', () => {
  const provider = new GrantAuthorizationProvider('test-broker', { alice: ['*'] }, CATALOG);

  test('denies when there is no provider at all', async () => {
    const decision = await authorize(request(), undefined, CATALOG);

    expect(decision.allowed).toBeFalse();
    expect(decision.reason).toContain('No authorization provider');
  });

  test('denies when the authority is not in the catalog', async () => {
    const bare = AuthorityCatalog.from(CORE_AUTHORITIES);
    const decision = await authorize(request(), provider, bare);

    expect(decision.allowed).toBeFalse();
    expect(decision.reason).toContain('is not registered');
    expect(await authorize(request(), provider, undefined)).toMatchObject({ allowed: false });
  });

  test('denies when the provider throws instead of answering', async () => {
    // Discord being unreachable, roles being unreadable and a bug in a provider
    // are the same thing here: not an answer, therefore not a yes.
    const broken: AuthorizationProvider = {
      authorize: () => {
        throw new Error('roles could not be verified');
      },
      id: 'broken',
    };

    const decision = await authorize(request(), broken, CATALOG);

    expect(decision).toMatchObject({ allowed: false, decidedBy: 'broken' });
    expect(decision.reason).toContain('roles could not be verified');
  });

  test('denies when the provider rejects asynchronously', async () => {
    const unreachable: AuthorizationProvider = {
      authorize: () => Promise.reject(new Error('service unavailable')),
      id: 'unreachable',
    };

    expect(await authorize(request(), unreachable, CATALOG)).toMatchObject({ allowed: false });
  });

  test('allows only through a provider that ran to completion', async () => {
    expect(await authorize(request(), provider, CATALOG)).toMatchObject({ allowed: true });
  });
});

describe('GrantAuthorizationProvider with groups', () => {
  const GROUPS: Record<string, readonly string[]> = {
    alice: ['role:ops'],
    bob: ['role:guests', 'role:ops'],
  };
  const provider = new GrantAuthorizationProvider(
    'test-broker',
    { 'role:ops': ['nox.files.read'], carol: ['nox.files.write'] },
    CATALOG,
    'grants',
    (subject) => GROUPS[subject] ?? [],
  );

  test('grants through a group the sender belongs to', async () => {
    expect(await provider.authorize(request({ principal: testPrincipal('alice') }))).toMatchObject({
      allowed: true,
      matchedGrant: 'nox.files.read',
    });
  });

  test('names the key that granted it, not only the pattern', async () => {
    const decision = await provider.authorize(request({ principal: testPrincipal('alice') }));

    // With roles in play, "granted nox.files.read" does not tell an auditor
    // whether it was this person or a role they happened to hold.
    expect(decision.reason).toContain('role:ops');
  });

  test('takes the union across groups rather than stopping at the first', async () => {
    expect(
      await provider.authorize(
        request({ authority: 'nox.files.read', principal: testPrincipal('bob') }),
      ),
    ).toMatchObject({ allowed: true });
  });

  test('still denies an authority no group of theirs was granted', async () => {
    expect(
      await provider.authorize(
        request({ authority: 'nox.files.write', principal: testPrincipal('alice') }),
      ),
    ).toMatchObject({ allowed: false });
  });

  test('grants directly to a sender with no groups at all', async () => {
    expect(
      await provider.authorize(
        request({ authority: 'nox.files.write', principal: testPrincipal('carol') }),
      ),
    ).toMatchObject({ allowed: true, matchedGrant: 'nox.files.write' });
  });

  test('denies a sender that neither is nor belongs to anything granted', async () => {
    const decision = await provider.authorize(request({ principal: testPrincipal('dave') }));

    expect(decision).toMatchObject({ allowed: false });
    expect(decision.reason).toContain('no grants configured');
  });

  // The same rule, over a boundary: a transport in another process reports a
  // failure by rejecting, and a rejection that escaped the guard would turn
  // "could not read roles" into a thrown authorization instead of a denial.
  test('denies rather than widens when the group lookup rejects', async () => {
    const unreachable = new GrantAuthorizationProvider(
      'test-broker',
      { 'role:ops': ['nox.files.read'] },
      CATALOG,
      'grants',
      () => Promise.reject(new Error('the transport is gone')),
    );

    expect(
      await unreachable.authorize(request({ principal: testPrincipal('alice') })),
    ).toMatchObject({ allowed: false });
  });

  test('waits for groups a transport answers asynchronously', async () => {
    const remote = new GrantAuthorizationProvider(
      'test-broker',
      { 'role:ops': ['nox.files.read'] },
      CATALOG,
      'grants',
      async (subject) => {
        await Promise.resolve();
        return subject === 'alice' ? ['role:ops'] : [];
      },
    );

    expect(
      await remote.authorize(
        request({ authority: 'nox.files.read', principal: testPrincipal('alice') }),
      ),
    ).toMatchObject({ allowed: true });
  });

  test('denies rather than widens when the group lookup throws', async () => {
    // A transport that cannot say which roles someone holds has not said they
    // hold one. Failing closed here is the same rule as everywhere else.
    const unreadable = new GrantAuthorizationProvider(
      'test-broker',
      { 'role:ops': ['nox.files.read'] },
      CATALOG,
      'grants',
      () => {
        throw new Error('roles unreadable');
      },
    );

    expect(
      await unreadable.authorize(request({ principal: testPrincipal('alice') })),
    ).toMatchObject({
      allowed: false,
    });
  });

  test('reflects a group removed since the session started', async () => {
    const held = new Set(['role:ops']);
    const live = new GrantAuthorizationProvider(
      'test-broker',
      { 'role:ops': ['nox.files.read'] },
      CATALOG,
      'grants',
      () => [...held],
    );

    expect(await live.authorize(request())).toMatchObject({ allowed: true });
    held.delete('role:ops');
    expect(await live.authorize(request())).toMatchObject({ allowed: false });
  });
});
