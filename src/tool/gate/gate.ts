import { nanoid } from 'nanoid';

import { principalKey, samePrincipal, SYSTEM_ISSUER } from '../../auth/principal';
import { raceWithAbort } from '../../utils/abort';
import { stableStringify } from '../../utils/json';
import { parseOrThrow } from '../../utils/validate';
import { gatePolicySchema } from './config';
import { RiskHeuristicEvaluator } from './heuristics';
import { RuleEvaluator } from './rules';

import type { GatePolicy, GatePolicyInput } from './config';
import type {
  GateAuditSink,
  GateDecision,
  GateEvaluation,
  GateEvaluator,
  GateRequest,
  PendingPermission,
  PermissionRequest,
  PermissionResolution,
} from './types';
import type { PrincipalRef } from '@nox/extension-api';

interface SessionGateOptions {
  readonly audit?: GateAuditSink;
  readonly evaluators?: readonly GateEvaluator[];
  /** A non-configurable approval floor derived from the session's participants. */
  readonly ownerApprovalRequired?: (request: GateRequest) => boolean;
  /** Behave as no configured Gate until the owner-approval floor activates. */
  readonly passthrough?: boolean;
}

interface PendingEntry {
  readonly finish: (resolution: PermissionResolution) => void;
  readonly request: PermissionRequest;
  resolvedBy?: PrincipalRef;
}

const VERDICT_STRENGTH = { abstain: 0, allow: 1, escalate: 2, deny: 3 } as const;

/**
 * What a session approval remembers. The principal is part of it: two people
 * may both hold `use` for an authority, and an approval Alice gave for one
 * exact call is not an approval Bob ever asked for. Leaving it out would let a
 * memo grant silently across participants of a shared conversation.
 */
function callKey(request: GateRequest): string {
  return [
    principalKey(request.runAuthority.principal),
    request.toolSetId,
    request.toolName,
    stableStringify(request.params),
  ].join('\n');
}

/** One live session's immutable policy, approvals and pending human decisions. */
class SessionGate {
  readonly #approved = new Set<string>();
  readonly #audit?: GateAuditSink;
  readonly #evaluators: readonly GateEvaluator[];
  readonly #ownerApprovalRequired?: (request: GateRequest) => boolean;
  readonly #passthrough: boolean;
  readonly #policy: GatePolicy;
  readonly #pending = new Map<string, PendingEntry>();
  readonly #rules: RuleEvaluator;
  readonly #sessionId: string;

  #stopped = false;

  constructor(sessionId: string, policy: GatePolicyInput, options: SessionGateOptions = {}) {
    this.#sessionId = sessionId;
    this.#policy = parseOrThrow(gatePolicySchema, policy);
    this.#audit = options.audit;
    this.#ownerApprovalRequired = options.ownerApprovalRequired;
    this.#passthrough = options.passthrough ?? false;
    this.#rules = new RuleEvaluator(this.#policy.rules);
    this.#evaluators = [
      new RiskHeuristicEvaluator(this.#policy.heuristics),
      ...(options.evaluators ?? []),
    ];
  }

  public async evaluate(request: GateRequest, signal?: AbortSignal): Promise<GateDecision> {
    this.#assertSession(request);
    const evaluationSignal = signal ?? new AbortController().signal;

    // An absent blueprint Gate is a true passthrough while one principal owns the
    // transcript. The derived floor still exists, because configuration may not
    // weaken the shared-conversation guarantee by omission.
    if (this.#passthrough) {
      return this.#needsOwnerApproval(request)
        ? this.#ownerApprovalFloor(request)
        : Object.freeze({
            decidedBy: 'passthrough',
            decisionId: nanoid(),
            reason: 'No Gate policy is configured for this session.',
            signals: Object.freeze([]),
            verdict: 'allow',
          });
    }

    // Explicit user policy is authoritative. Evaluators may extend ambiguous
    // cases, but neither heuristics nor a future reviewer can weaken a rule.
    const ruled = this.#rules.evaluate(request);
    if (ruled.verdict === 'deny') return this.#record(request, 'rules', ruled);
    if (ruled.verdict === 'escalate') return this.#record(request, 'rules', ruled);

    // The shared floor is stronger than an allow rule and than a memo created
    // before another principal contaminated the transcript. With no explicit
    // allow, evaluators still run so a deny can remain terminal.
    const ownerApprovalRequired = this.#needsOwnerApproval(request);
    if (ownerApprovalRequired && ruled.verdict === 'allow') {
      return this.#ownerApprovalFloor(request);
    }

    // Session approval is exact-call memoization. It can satisfy escalation but
    // never reaches this point through a deterministic deny or the hard floor.
    if (!ownerApprovalRequired && this.#approved.has(callKey(request))) {
      return this.#record(request, 'memo', {
        reason: 'Approved earlier in this live session.',
        verdict: 'allow',
      });
    }
    if (ruled.verdict === 'allow') return this.#record(request, 'rules', ruled);

    const evaluations = await raceWithAbort(evaluationSignal, () =>
      Promise.all(
        this.#evaluators.map(async (evaluator) => ({
          evaluation: await evaluator.evaluate(request, evaluationSignal),
          evaluatorId: evaluator.id,
        })),
      ),
    );
    const signals = evaluations.flatMap(({ evaluation }) => [...(evaluation.signals ?? [])]);
    const strongest = evaluations.reduce<(typeof evaluations)[number] | undefined>(
      (selected, candidate) => {
        if (candidate.evaluation.verdict === 'abstain') return selected;
        if (selected === undefined) return candidate;
        return VERDICT_STRENGTH[candidate.evaluation.verdict] >
          VERDICT_STRENGTH[selected.evaluation.verdict]
          ? candidate
          : selected;
      },
      undefined,
    );

    // A deny signal remains terminal; otherwise a principal that arrived while
    // asynchronous evaluators were running raises the verdict to escalation.
    if (strongest?.evaluation.verdict === 'deny') {
      return this.#record(request, strongest.evaluatorId, {
        ...strongest.evaluation,
        signals,
      });
    }
    if (this.#needsOwnerApproval(request)) return this.#ownerApprovalFloor(request, signals);

    if (strongest !== undefined && strongest.evaluation.verdict !== 'abstain') {
      return this.#record(request, strongest.evaluatorId, {
        ...strongest.evaluation,
        signals,
      });
    }

    return this.#record(request, 'default', {
      reason: 'No gate rule or evaluator decided.',
      signals,
      verdict: this.#policy.defaultVerdict,
    });
  }

  public requestPermission(
    request: GateRequest,
    decision: GateDecision,
    signal?: AbortSignal,
  ): PendingPermission {
    this.#assertSession(request);
    if (decision.verdict !== 'escalate') {
      throw new Error(`Cannot request permission for a ${decision.verdict} gate decision.`);
    }

    const requestId = decision.decisionId;
    const requestedAt = new Date();
    const permission: PermissionRequest = Object.freeze({
      ...request,
      expiresAt: new Date(requestedAt.getTime() + this.#policy.escalationTimeoutMs),
      reason: decision.reason,
      requestId,
      requestedAt,
      signals: decision.signals,
    });

    let finishOutcome!: (resolution: PermissionResolution) => void;
    const outcome = new Promise<PermissionResolution>((resolve) => {
      finishOutcome = resolve;
    });

    const pendingForOwner = [...this.#pending.values()].filter(({ request: pending }) =>
      samePrincipal(pending.runAuthority.principal, request.runAuthority.principal),
    ).length;
    if (pendingForOwner >= this.#policy.maxPendingPermissions) {
      const resolution: PermissionResolution = { resolution: 'denied' };
      this.#audit?.resolve(requestId, resolution, new Date());
      finishOutcome(resolution);
      return Object.freeze({ accepted: false, outcome, request: permission });
    }

    let finished = false;
    const lifecycle: {
      onAbort?: () => void;
      timer?: ReturnType<typeof setTimeout>;
    } = {};
    const finish = (resolution: PermissionResolution): void => {
      if (finished) return;
      finished = true;
      clearTimeout(lifecycle.timer);
      if (lifecycle.onAbort !== undefined) {
        signal?.removeEventListener('abort', lifecycle.onAbort);
      }
      // Read before the entry leaves the map: `resolve` stamps who answered on
      // it, and the audit line is the only place that ever gets to say so.
      const resolvedBy = this.#pending.get(requestId)?.resolvedBy;
      this.#pending.delete(requestId);
      if (resolution.resolution === 'approved' && resolution.scope === 'session') {
        this.#approved.add(callKey(request));
      }
      this.#audit?.resolve(requestId, resolution, new Date(), resolvedBy);
      finishOutcome(resolution);
    };
    lifecycle.onAbort = (): void => {
      finish({ resolution: 'aborted' });
    };
    lifecycle.timer = setTimeout(() => {
      finish({ resolution: 'timeout' });
    }, this.#policy.escalationTimeoutMs);

    this.#pending.set(requestId, { finish, request: permission });
    if (this.#stopped || signal?.aborted === true) finish({ resolution: 'aborted' });
    else signal?.addEventListener('abort', lifecycle.onAbort, { once: true });

    return Object.freeze({ accepted: true, outcome, request: permission });
  }

  public listPending(): readonly PermissionRequest[] {
    return Object.freeze([...this.#pending.values()].map(({ request }) => request));
  }

  /**
   * Answers a pending request. `resolvedBy` is required and has to be the
   * principal whose run asked: only the originator may approve, there is no
   * delegated approval and no administrator rescue. Enforcing it here rather
   * than only at the transport means no surface can reach around it.
   */
  public resolve(
    requestId: string,
    resolution: 'denied' | { approved: 'once' | 'session' },
    resolvedBy: PrincipalRef,
  ): boolean {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return false;
    if (!samePrincipal(pending.request.runAuthority.principal, resolvedBy)) return false;
    if (pending.request.expiresAt.getTime() <= Date.now()) return false;

    pending.resolvedBy = resolvedBy;
    pending.finish(
      resolution === 'denied'
        ? { resolution: 'denied' }
        : { resolution: 'approved', scope: resolution.approved },
    );
    return true;
  }

  public stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const { finish } of [...this.#pending.values()]) finish({ resolution: 'aborted' });
    this.#approved.clear();
  }

  #needsOwnerApproval(request: GateRequest): boolean {
    return this.#ownerApprovalRequired?.(request) === true;
  }

  #ownerApprovalFloor(request: GateRequest, signals: GateDecision['signals'] = []): GateDecision {
    return this.#record(request, 'shared-conversation', {
      reason:
        'This session contains more than one principal, so an effectful call requires fresh ' +
        'approval from its owner.',
      signals,
      verdict: 'escalate',
    });
  }

  #record(
    request: GateRequest,
    decidedBy: string,
    evaluation: Exclude<GateEvaluation, { verdict: 'abstain' }>,
  ): GateDecision {
    // An escalation is a question for a human originator. A system run has none,
    // so recording an intermediate escalation would leave audit looking pending
    // forever even though the only possible outcome is terminal denial.
    const terminal: Exclude<GateEvaluation, { verdict: 'abstain' }> =
      evaluation.verdict === 'escalate' && request.runAuthority.principal.issuer === SYSTEM_ISSUER
        ? {
            ...evaluation,
            reason:
              `${evaluation.reason} This run has no human originator, and approval ` +
              'cannot be delegated.',
            verdict: 'deny',
          }
        : evaluation;
    const decision: GateDecision = Object.freeze({
      decidedBy,
      decisionId: nanoid(),
      reason: terminal.reason,
      signals: Object.freeze([...(terminal.signals ?? [])]),
      verdict: terminal.verdict,
    });
    this.#audit?.record({
      ...request,
      createdAt: new Date(),
      ...decision,
    });
    return decision;
  }

  #assertSession(request: GateRequest): void {
    if (request.sessionId !== this.#sessionId) {
      throw new Error(
        `Gate for session ${this.#sessionId} cannot evaluate session ${request.sessionId}.`,
      );
    }
  }
}

export { SessionGate };

export type { SessionGateOptions };
