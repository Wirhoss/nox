import { bindTool } from '@nox/extension-api';

import { COMPACT_PROMPT } from './agent/context/prompt';
import { TITLE_PROMPT } from './agent/title';
import { AuthorityCatalog } from './auth/authority';
import { CORE_AUTHORITIES } from './auth/coreAuthorities';
import { principal } from './auth/principal';

import type { AuthorizationDecision, AuthorizationProvider } from './auth/authorization';
import type { BoundTool, MessageOrigin, PrincipalRef, Tool } from '@nox/extension-api';

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

/**
 * Whether a provider request is Nox talking to itself rather than the
 * conversation: compacting the working set, or naming the session. A test
 * provider that records what the agent was sent uses this to leave them out —
 * they carry their own system prompt and no tools, and counting them as turns
 * would make every assertion about a conversation depend on internal machinery
 * that is not part of it.
 */
function isInternalRequest(systemPrompt: string): boolean {
  return systemPrompt === COMPACT_PROMPT || systemPrompt === TITLE_PROMPT;
}

/**
 * A tool as the session table holds it.
 *
 * Production binds every tool to the set it was granted through, because the
 * gate subject is that pair. A test that hands a bare tool to a session would
 * be exercising a table shape that cannot occur.
 */
function testBoundTool(tool: Tool, toolSetId = 'test.tools'): BoundTool {
  return bindTool(tool, toolSetId);
}

export {
  isInternalRequest,
  permissiveAuthorization,
  TEST_AUTHORITY,
  testBoundTool,
  testCatalog,
  testOrigin,
  testPrincipal,
};
