import { describe, expect, test } from 'bun:test';

import { testCatalog, testPrincipal } from '../testFixtures';
import { AuthorityCatalog } from './authority';
import {
  type AuthorizationProvider,
  type AuthorizationRequest,
  authorize,
  GrantAuthorizationProvider,
} from './authorization';
import { CORE_AUTHORITIES } from './coreAuthorities';

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

describe('GrantAuthorizationProvider', () => {
  const provider = new GrantAuthorizationProvider(
    'test-broker',
    { alice: ['nox.files.read'], root: ['*'] },
    CATALOG,
  );

  test('allows a granted authority and names the entry that matched', () => {
    expect(provider.authorize(request())).toMatchObject({
      allowed: true,
      matchedGrant: 'nox.files.read',
    });
    expect(
      provider.authorize(
        request({ authority: 'nox.files.write', principal: testPrincipal('root') }),
      ),
    ).toMatchObject({ allowed: true, matchedGrant: '*' });
  });

  test('denies an authority the principal was not granted', () => {
    expect(provider.authorize(request({ authority: 'nox.files.write' }))).toMatchObject({
      allowed: false,
    });
  });

  test('denies a principal with no grants at all', () => {
    const decision = provider.authorize(request({ principal: testPrincipal('stranger') }));

    expect(decision.allowed).toBeFalse();
    expect(decision.reason).toContain('no grants configured');
  });

  test('denies a principal issued by another transport', () => {
    // The same subject on a different broker is a different person.
    const decision = provider.authorize(
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
