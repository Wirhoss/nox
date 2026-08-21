import type { GateAuditSink, PermissionResolution, RiskSignal } from '../tool/gate/types';
import type { ToolRisk } from '../tool/tool';
import type { PrincipalRef } from './principal';

/**
 * One authorization decision, kept whether it allowed or denied. A deny never
 * reaches the Gate and would otherwise leave no trace at all, which is exactly
 * the decision an operator most needs to find afterwards.
 */
interface AuthorizationAuditRecord {
  readonly authority: string;
  readonly createdAt: Date;
  readonly decidedBy: string;
  readonly decisionId: string;
  readonly matchedGrant?: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly principal: PrincipalRef;
  readonly reason: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly toolSetId: string;
  readonly trackId: string;
  readonly verdict: 'allow' | 'deny';
}

/** Which half of the pipeline produced a stored decision. */
type DecisionStage = 'authorization' | 'gate';

/**
 * Both halves of the decision pipeline write here. They are one timeline on
 * purpose: "why did this call not happen" has two possible answers, and an
 * operator should not have to know which one to look in.
 */
interface DecisionAuditSink extends GateAuditSink {
  authorize(record: AuthorizationAuditRecord): void;
}

/**
 * One stored decision, read back. It is deliberately flat and deliberately not a
 * `GateRequest`: an audit line is a record of what was decided, not a call that
 * can be replayed, and pretending otherwise would mean inventing the halves of a
 * request that were never worth storing.
 */
interface StoredDecision {
  readonly authority: string;
  readonly createdAt: Date;
  readonly decidedBy: string;
  readonly decisionId: string;
  readonly matchedGrant?: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly preview?: string;
  readonly principal: PrincipalRef;
  readonly reason: string;
  readonly resolution?: PermissionResolution['resolution'];
  readonly resolvedAt?: Date;
  readonly resolvedBy?: PrincipalRef;
  readonly risk?: ToolRisk;
  readonly runId: string;
  readonly scope?: 'once' | 'session';
  readonly sessionId: string;
  readonly signals?: readonly RiskSignal[];
  readonly stage: DecisionStage;
  readonly title?: string;
  readonly toolName: string;
  readonly toolSetId: string;
  readonly trackId: string;
  readonly verdict: 'allow' | 'deny' | 'escalate';
}

export type { AuthorizationAuditRecord, DecisionAuditSink, DecisionStage, StoredDecision };
