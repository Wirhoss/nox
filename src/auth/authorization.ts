import { type PrincipalRef, principalToString } from '@nox/extension-api';

import { raceWithAbort } from '../utils/abort';
import { type AuthorityCatalog, type GrantPattern, matchesPattern } from './authority';

import type { Logger } from '../logger/logger';

/**
 * One question, asked once per tool call: may this principal use this authority?
 *
 * It carries the call it is about so a provider can log and audit meaningfully,
 * but the decision is over the authority alone — the concrete risk of these exact
 * parameters is the Gate's job, and it still runs afterwards.
 *
 * There is no `conversationId` here on purpose. A provider is built for a session
 * and already closes over the broker and conversation it belongs to; the Runner
 * knows a session, and should not have to carry transport metadata to ask.
 */
interface AuthorizationRequest {
  readonly authority: string;
  readonly principal: PrincipalRef;
  readonly runId: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly toolSetId: string;
  readonly trackId: string;
}

/**
 * Authorization is binary — a principal has `use` for an authority or does not.
 * There is no `request` level: a principal without `use` is denied before the
 * Gate and never produces something a human could approve.
 *
 * The decision is rich rather than boolean because every one of them is audited,
 * and "denied" with no reason is a support ticket nobody can answer.
 */
type AuthorizationDecision =
  | {
      readonly allowed: false;
      readonly decidedBy: string;
      readonly matchedGrant?: string;
      readonly reason: string;
    }
  | {
      readonly allowed: true;
      readonly decidedBy: string;
      readonly matchedGrant: string;
      readonly reason: string;
    };

/**
 * Where authority comes from. A session is handed a reference, not a snapshot:
 * the tool catalog is stable for a conversation, but who may use what can change
 * while it is still going, and asking again per call is what makes that true.
 */
interface AuthorizationProvider {
  readonly id: string;
  authorize(
    request: AuthorizationRequest,
    signal: AbortSignal,
  ): AuthorizationDecision | Promise<AuthorizationDecision>;
}

/** Who decided, when nothing downstream got the chance to. */
const AUTHORIZATION_DECIDER = 'authorization';

function deny(reason: string, decidedBy = AUTHORIZATION_DECIDER): AuthorizationDecision {
  return Object.freeze({ allowed: false, decidedBy, reason });
}

/**
 * The one way to ask, and the reason no caller has to remember to fail closed.
 *
 * Every path that is not an explicit allow from a provider that ran to completion
 * ends as a deny with a reason: no provider, an authority nobody registered, a
 * provider that threw, a provider that could not reach whatever it consults.
 */
async function authorize(
  request: AuthorizationRequest,
  provider: AuthorizationProvider | undefined,
  catalog: AuthorityCatalog | undefined,
  signal: AbortSignal = new AbortController().signal,
  logger?: Logger,
): Promise<AuthorizationDecision> {
  if (catalog?.has(request.authority) !== true) {
    logger?.error(
      { authority: request.authority, toolName: request.toolName },
      'Refused a tool call for an authority no extension registered.',
    );
    return deny(
      `Authority "${request.authority}" is not registered, so nothing can be authorized for it.`,
    );
  }

  if (provider === undefined) {
    logger?.error(
      { authority: request.authority, toolName: request.toolName },
      'Refused a tool call because this session has no authorization provider.',
    );
    return deny('No authorization provider is configured for this session.');
  }

  try {
    return await raceWithAbort(signal, () => provider.authorize(request, signal));
  } catch (error) {
    if (signal.aborted) {
      return deny('Authorization was cancelled because the run was aborted.', provider.id);
    }

    // A provider that cannot answer has not answered "yes". Discord being down,
    // roles being unreadable and a bug in a provider are the same thing here.
    logger?.error(
      { authority: request.authority, err: error, toolName: request.toolName },
      'Authorization provider failed; denying the tool call.',
    );
    return deny(
      `The authorization provider failed to decide: ${
        error instanceof Error ? error.message : String(error)
      }`,
      provider.id,
    );
  }
}

/** What one issuer's subjects are allowed to use, as written in configuration. */
type PrincipalGrants = Readonly<Record<string, readonly GrantPattern[]>>;

/** Full authority for the sole owner authenticated by an issuer. */
class OwnerAuthorizationProvider implements AuthorizationProvider {
  public readonly id: string;

  readonly #issuer: string;

  /**
   * Full authority for the owner authenticated by a trusted transport. This is
   * intentionally issuer-scoped: using it behind a transport that admits more
   * than the installation owner would turn authentication into authorization.
   */
  constructor(issuer: string, id = `owner:${issuer}`) {
    this.id = id;
    this.#issuer = issuer;
  }

  public authorize(request: AuthorizationRequest): AuthorizationDecision {
    if (request.principal.issuer !== this.#issuer) {
      return deny(
        `Principal ${principalToString(request.principal)} was not issued by "${this.#issuer}".`,
        this.id,
      );
    }

    return Object.freeze({
      allowed: true,
      decidedBy: this.id,
      matchedGrant: '*',
      reason: `Authenticated owner on "${this.#issuer}".`,
    });
  }
}

/**
 * The groups a subject belongs to right now, as extra keys its grants may be
 * written against. Asked per call rather than snapshotted, because membership
 * changes while a session is still going and the answer that matters is the one
 * true at the moment of the call.
 */
type SubjectGroups = (subject: string) => readonly string[];

/**
 * Authorization from configured grants, scoped to a single issuer. One instance
 * belongs to one broker: the issuer is that broker's configured ID, the subjects
 * are the sender IDs it authenticates, and a principal from any other issuer is
 * denied — the same subject on a different transport is a different person.
 *
 * A grant key is either a sender the transport authenticates or a group it
 * reports that sender belongs to; both are looked up the same way and neither
 * outranks the other — authority is the union, because two permissions do not
 * subtract. Restricting someone who holds a permissive role is done by not
 * giving them the role, not by a narrower entry that would silently never apply.
 */
class GrantAuthorizationProvider implements AuthorizationProvider {
  public readonly id: string;

  readonly #grants: ReadonlyMap<string, readonly GrantPattern[]>;
  readonly #groups?: SubjectGroups;
  readonly #issuer: string;

  /**
   * Grants are validated at load, so an authority nobody registered fails beside
   * the entry that named it instead of becoming a grant that silently never matches.
   */
  constructor(
    issuer: string,
    grants: PrincipalGrants,
    catalog: AuthorityCatalog,
    id = 'grants',
    groups?: SubjectGroups,
  ) {
    this.id = id;
    this.#issuer = issuer;
    if (groups !== undefined) this.#groups = groups;

    const compiled = new Map<string, readonly GrantPattern[]>();
    for (const [subject, patterns] of Object.entries(grants)) {
      for (const pattern of patterns) {
        catalog.assertGrantPattern(pattern, `Principal "${issuer}:${subject}"`);
      }
      compiled.set(subject, Object.freeze([...patterns]));
    }
    this.#grants = compiled;
  }

  /**
   * Every grant key that speaks for this subject: the subject itself, then the
   * groups the transport reports for it. A transport that reports none, or that
   * throws while trying, contributes nothing — a group lookup can only ever add
   * authority, so failing to resolve one denies rather than widens.
   */
  #keysFor(subject: string): readonly string[] {
    if (this.#groups === undefined) return [subject];

    try {
      return [subject, ...this.#groups(subject)];
    } catch {
      return [subject];
    }
  }

  public authorize(request: AuthorizationRequest): AuthorizationDecision {
    const { authority, principal } = request;

    if (principal.issuer !== this.#issuer) {
      return deny(
        `Principal ${principalToString(principal)} was not issued by "${this.#issuer}".`,
        this.id,
      );
    }

    let configured = false;
    for (const key of this.#keysFor(principal.subject)) {
      const patterns = this.#grants.get(key);
      if (patterns === undefined) continue;
      configured = true;

      const matched = patterns.find((pattern) => matchesPattern(pattern, authority));
      if (matched === undefined) continue;

      return Object.freeze({
        allowed: true,
        decidedBy: this.id,
        matchedGrant: matched,
        // The key is named as well as the pattern: with roles in play, "granted
        // nox.x" does not tell an auditor whether it was this person or a role
        // they happened to hold, and that is the whole question afterwards.
        reason: `Granted "${matched}" by "${key}".`,
      });
    }

    if (!configured) {
      return deny(`Principal ${principalToString(principal)} has no grants configured.`, this.id);
    }

    return deny(
      `Principal ${principalToString(principal)} is not granted "${authority}".`,
      this.id,
    );
  }
}

export { authorize, GrantAuthorizationProvider, OwnerAuthorizationProvider };

export type {
  AuthorizationDecision,
  AuthorizationProvider,
  AuthorizationRequest,
  PrincipalGrants,
  SubjectGroups,
};
