import { AuthorityCatalog } from './auth/authority';
import { CORE_AUTHORITIES } from './auth/coreAuthorities';
import { type MessageOrigin, principal, type PrincipalRef } from './auth/principal';

import type { AuthorizationDecision, AuthorizationProvider } from './auth/authorization';

/**
 * Shared fixtures for the test suite — imported by tests, never a test itself,
 * which is why the name deliberately avoids `.test.ts`: that suffix is what the
 * runner collects, and this would become an empty suite.
 *
 * Multiuser authorization touches almost every seam — a message needs an origin,
 * a session needs a catalog and a provider — and restating that in every file
 * would be the same three lines written thirty times, each free to drift into
 * its own idea of what a principal looks like.
 */
const TEST_ISSUER = 'test-broker';

/** The authority tests hang their own tools off. Owned by the core namespace. */
const TEST_AUTHORITY = 'nox.test.tool';

function testPrincipal(subject = 'alice'): PrincipalRef {
  return principal(TEST_ISSUER, subject);
}

let transportSequence = 0;

function testOrigin(subject = 'alice'): MessageOrigin {
  transportSequence += 1;
  return {
    principal: testPrincipal(subject),
    transportMessageId: `transport-${String(transportSequence)}`,
  };
}

/** The core catalog plus whatever authorities a test invents for its tools. */
function testCatalog(...ids: readonly string[]): AuthorityCatalog {
  return AuthorityCatalog.from([
    ...CORE_AUTHORITIES,
    ...[TEST_AUTHORITY, ...ids].map((id) => ({
      description: `Test authority ${id}.`,
      id,
      ownerExtensionId: 'nox',
    })),
  ]);
}

/**
 * Allows everything, for the many tests that are about something else entirely.
 * Tests about authorization build their own provider or use real grants.
 */
const permissiveAuthorization: AuthorizationProvider = Object.freeze({
  authorize: (): AuthorizationDecision => ({
    allowed: true,
    decidedBy: 'test-permissive',
    matchedGrant: '*',
    reason: 'The permissive test provider allows everything.',
  }),
  id: 'test-permissive',
});

export { permissiveAuthorization, TEST_AUTHORITY, testCatalog, testOrigin, testPrincipal };
