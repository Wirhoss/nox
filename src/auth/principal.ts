import type { MessageOrigin, PrincipalRef } from '@nox/extension-api';

/**
 * What started a run. A human message names the message it came in on; anything
 * Nox does on its own names the cause instead, and still carries an explicit
 * system principal rather than nothing.
 */
type RunAuthoritySource =
  | { readonly causeId: string; readonly type: 'system' }
  | { readonly messageId: string; readonly type: 'message' };

/**
 * The authority one run executes under. Fixed when the run starts, immutable for
 * its whole length, and captured explicitly by every tool call it makes.
 *
 * Known limitation, accepted deliberately: in a shared conversation the model
 * sees historical messages from other principals, and the effective authority
 * remains the one that started the run. That does not eliminate confused-deputy
 * attacks through context contamination. The mitigation for consequential calls
 * is the Gate escalating and showing the exact call to the originator.
 */
interface RunAuthority {
  readonly principal: PrincipalRef;
  readonly source: RunAuthoritySource;
}

/**
 * The issuer every principal Nox invents for itself belongs to. It is a real
 * issuer with real subjects, not a hole in the model: a system run is authorized
 * exactly like anyone else, and starts with nothing granted.
 */
const SYSTEM_ISSUER = 'nox.system';

function principal(issuer: string, subject: string): PrincipalRef {
  return Object.freeze({ issuer, subject });
}

/** A principal for work Nox does on its own. It still needs explicit grants. */
function systemPrincipal(subject: string): PrincipalRef {
  return principal(SYSTEM_ISSUER, subject);
}

/** Scheduled work, authorized only by the grants carried by its durable job. */
const SYSTEM_CRON = systemPrincipal('cron');

/** Nox acting for its own machinery — compaction handoffs and the like. */
const SYSTEM_INTERNAL = systemPrincipal('internal');

/** A single comparable string. The separator cannot occur in either half. */
function principalKey(reference: PrincipalRef): string {
  return `${reference.issuer}\u0000${reference.subject}`;
}

function samePrincipal(left: PrincipalRef, right: PrincipalRef): boolean {
  return left.issuer === right.issuer && left.subject === right.subject;
}

/**
 * The authority a message confers, taken at the moment it is queued. The
 * principal is copied rather than referenced: this is read on every tool call
 * for the whole run, and a caller still holding the origin it passed in must not
 * be able to move it afterwards.
 */
function messageAuthority(origin: MessageOrigin, messageId: string): RunAuthority {
  return Object.freeze({
    principal: principal(origin.principal.issuer, origin.principal.subject),
    source: Object.freeze({ messageId, type: 'message' as const }),
  });
}

function systemAuthority(subject: PrincipalRef, causeId: string): RunAuthority {
  return Object.freeze({
    principal: principal(subject.issuer, subject.subject),
    source: Object.freeze({ causeId, type: 'system' as const }),
  });
}

export {
  messageAuthority,
  principal,
  principalKey,
  samePrincipal,
  SYSTEM_CRON,
  SYSTEM_INTERNAL,
  SYSTEM_ISSUER,
  systemAuthority,
};

export type { RunAuthority, RunAuthoritySource };
