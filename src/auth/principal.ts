import { z } from 'zod';

/**
 * Who is acting, as two halves that only mean something together: the authority
 * that vouched for the identity, and the identity it vouched for. A Discord user
 * id is not a principal on its own — it is a principal *on that broker*, and the
 * same number on another transport is somebody else entirely.
 *
 * Nothing in Nox may treat an absent principal as a permissive one. Every run has
 * exactly one, and a surface that cannot name it does not get to act.
 */
interface PrincipalRef {
  readonly issuer: string;
  readonly subject: string;
}

/**
 * Where a message came from, kept for attribution and audit — and so the model
 * can be told who said what in a shared conversation.
 *
 * This is provenance, never authority. The effective authority of an execution is
 * fixed when its run starts and is not recomputed from the transcript, because a
 * transcript in a shared channel contains other people's words.
 */
interface MessageOrigin {
  readonly principal: PrincipalRef;
  readonly transportMessageId: string;
}

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

const principalRefSchema = z.object({
  issuer: z.string().trim().min(1),
  subject: z.string().trim().min(1),
});

function principal(issuer: string, subject: string): PrincipalRef {
  return Object.freeze({ issuer, subject });
}

/** A principal for work Nox does on its own. It still needs explicit grants. */
function systemPrincipal(subject: string): PrincipalRef {
  return principal(SYSTEM_ISSUER, subject);
}

/** Scheduled work. No cron exists yet; the abstraction simply never lacks one. */
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

/** For logs, audit lines and anything a human reads. */
function principalToString(reference: PrincipalRef): string {
  return `${reference.issuer}:${reference.subject}`;
}

/**
 * The authority a message confers, taken at the moment it is queued. The
 * principal is copied rather than referenced: this is read on every tool call
 * for the whole run, and a caller still holding the origin it passed in must not
 * be able to move it afterwards.
 */
function messageAuthority(origin: MessageOrigin, messageId: string): RunAuthority {
  return Object.freeze({
    principal: Object.freeze({ ...origin.principal }),
    source: Object.freeze({ messageId, type: 'message' as const }),
  });
}

function systemAuthority(subject: PrincipalRef, causeId: string): RunAuthority {
  return Object.freeze({
    principal: Object.freeze({ ...subject }),
    source: Object.freeze({ causeId, type: 'system' as const }),
  });
}

export {
  messageAuthority,
  principal,
  principalKey,
  principalRefSchema,
  principalToString,
  samePrincipal,
  SYSTEM_CRON,
  SYSTEM_INTERNAL,
  SYSTEM_ISSUER,
  systemAuthority,
  systemPrincipal,
};

export type { MessageOrigin, PrincipalRef, RunAuthority, RunAuthoritySource };
