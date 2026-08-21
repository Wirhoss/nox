import { raceWithAbort } from '../utils/abort';
import { type AuthorityCatalog, type GrantPattern, matchesPattern } from './authority';
import { type PrincipalRef, principalToString } from './principal';

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

/**
 * Authorization from configured grants, scoped to a single issuer.
 *
 * One instance belongs to one broker: the issuer is that broker's configured ID,
 * and the subjects are the sender IDs it authenticates. A principal from any
 * other issuer is unknown here and is denied — the same subject on a different
 * transport is a different person, and this is where that stays true.
 */
class GrantAuthorizationProvider implements AuthorizationProvider {
  public readonly id: string;

  readonly #grants: ReadonlyMap<string, readonly GrantPattern[]>;
  readonly #issuer: string;

  /**
   * Grants are validated here rather than on first use, so an authority nobody
   * registered fails at load with the entry that named it, instead of becoming a
   * grant that silently never matches anything.
   */
  constructor(issuer: string, grants: PrincipalGrants, catalog: AuthorityCatalog, id = 'grants') {
    this.id = id;
    this.#issuer = issuer;

    const compiled = new Map<string, readonly GrantPattern[]>();
    for (const [subject, patterns] of Object.entries(grants)) {
      for (const pattern of patterns) {
        catalog.assertGrantPattern(pattern, `Principal "${issuer}:${subject}"`);
      }
      compiled.set(subject, Object.freeze([...patterns]));
    }
    this.#grants = compiled;
  }

  public authorize(request: AuthorizationRequest): AuthorizationDecision {
    const { authority, principal } = request;

    if (principal.issuer !== this.#issuer) {
      return deny(
        `Principal ${principalToString(principal)} was not issued by "${this.#issuer}".`,
        this.id,
      );
    }

    const patterns = this.#grants.get(principal.subject);
    if (patterns === undefined) {
      return deny(`Principal ${principalToString(principal)} has no grants configured.`, this.id);
    }

    const matched = patterns.find((pattern) => matchesPattern(pattern, authority));
    if (matched === undefined) {
      return deny(
        `Principal ${principalToString(principal)} is not granted "${authority}".`,
        this.id,
      );
    }

    return Object.freeze({
      allowed: true,
      decidedBy: this.id,
      matchedGrant: matched,
      reason: `Granted "${matched}".`,
    });
  }
}

export { authorize, GrantAuthorizationProvider };

export type { AuthorizationDecision, AuthorizationProvider, AuthorizationRequest, PrincipalGrants };
