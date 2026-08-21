import { nanoid } from 'nanoid';

import { stableStringify } from '../../utils/json';
import { parseOrThrow } from '../../utils/validate';
import { type GatePolicy, type GatePolicyInput, gatePolicySchema } from './config';
import { RiskHeuristicEvaluator } from './heuristics';
import { RuleEvaluator } from './rules';

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

interface SessionGateOptions {
  readonly audit?: GateAuditSink;
  readonly evaluators?: readonly GateEvaluator[];
}

interface PendingEntry {
  readonly finish: (resolution: PermissionResolution) => void;
  readonly request: PermissionRequest;
}

const VERDICT_STRENGTH = { abstain: 0, allow: 1, escalate: 2, deny: 3 } as const;

function callKey(request: GateRequest): string {
  return `${request.toolSetId}\n${request.toolName}\n${stableStringify(request.params)}`;
}

/** One live session's immutable policy, approvals and pending human decisions. */
class SessionGate {
  readonly #approved = new Set<string>();
  readonly #audit?: GateAuditSink;
  readonly #evaluators: readonly GateEvaluator[];
  readonly #policy: GatePolicy;
  readonly #pending = new Map<string, PendingEntry>();
  readonly #rules: RuleEvaluator;
  readonly #sessionId: string;

  #stopped = false;

  constructor(sessionId: string, policy: GatePolicyInput, options: SessionGateOptions = {}) {
    this.#sessionId = sessionId;
    this.#policy = parseOrThrow(gatePolicySchema, policy);
    this.#audit = options.audit;
    this.#rules = new RuleEvaluator(this.#policy.rules);
    this.#evaluators = [
      new RiskHeuristicEvaluator(this.#policy.heuristics),
      ...(options.evaluators ?? []),
    ];
  }

  public async evaluate(request: GateRequest): Promise<GateDecision> {
    this.#assertSession(request);

    // Explicit user policy is authoritative. Evaluators may extend ambiguous
    // cases, but neither heuristics nor a future reviewer can weaken a rule.
    const ruled = this.#rules.evaluate(request);
    if (ruled.verdict === 'deny') return this.#record(request, 'rules', ruled);

    // Session approval is exact-call memoization. It can satisfy escalation but
    // never reaches this point through a deterministic deny.
    if (this.#approved.has(callKey(request))) {
      return this.#record(request, 'memo', {
        reason: 'Approved earlier in this live session.',
        verdict: 'allow',
      });
    }
    if (ruled.verdict !== 'abstain') return this.#record(request, 'rules', ruled);

    const evaluations = await Promise.all(
      this.#evaluators.map(async (evaluator) => ({
        evaluation: await evaluator.evaluate(request),
        evaluatorId: evaluator.id,
      })),
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
      this.#pending.delete(requestId);
      if (resolution.resolution === 'approved' && resolution.scope === 'session') {
        this.#approved.add(callKey(request));
      }
      this.#audit?.resolve(requestId, resolution, new Date());
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

    return Object.freeze({ outcome, request: permission });
  }

  public listPending(): readonly PermissionRequest[] {
    return Object.freeze([...this.#pending.values()].map(({ request }) => request));
  }

  public resolve(
    requestId: string,
    resolution: 'denied' | { approved: 'once' | 'session' },
  ): boolean {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return false;

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

  #record(
    request: GateRequest,
    decidedBy: string,
    evaluation: Exclude<GateEvaluation, { verdict: 'abstain' }>,
  ): GateDecision {
    const decision: GateDecision = Object.freeze({
      decidedBy,
      decisionId: nanoid(),
      reason: evaluation.reason,
      signals: Object.freeze([...(evaluation.signals ?? [])]),
      verdict: evaluation.verdict,
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
