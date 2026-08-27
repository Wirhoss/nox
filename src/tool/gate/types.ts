import type { RunAuthority } from '../../auth/principal';
import type { PrincipalRef, ToolRisk } from '@nox/extension-api';

interface RiskSignal {
  readonly code: string;
  readonly reason: string;
  readonly resource?: string;
  readonly severity: 'approval' | 'deny' | 'info' | 'review';
}

/**
 * One concrete call, put to the Gate. It arrives already authorized: the
 * principal has `use` for `authority`, and what is left to decide is whether
 * these exact parameters are safe. Holding `authority` and the run's authority
 * here is what lets a decision be audited and an escalation be addressed to
 * the one person entitled to answer it.
 */
interface GateRequest {
  readonly authority: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly preview?: string;
  readonly risk?: ToolRisk;
  readonly runAuthority: RunAuthority;
  readonly runId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly toolName: string;
  readonly toolSetId: string;
  readonly trackId: string;
}

type GateVerdict = 'allow' | 'deny' | 'escalate';

type GateEvaluation =
  | {
      readonly reason: string;
      readonly signals?: readonly RiskSignal[];
      readonly verdict: GateVerdict;
    }
  | { readonly signals?: readonly RiskSignal[]; readonly verdict: 'abstain' };

interface GateEvaluator {
  readonly id: string;
  evaluate(request: GateRequest, signal: AbortSignal): GateEvaluation | Promise<GateEvaluation>;
}

interface GateDecision {
  readonly decidedBy: string;
  readonly decisionId: string;
  readonly reason: string;
  readonly signals: readonly RiskSignal[];
  readonly verdict: GateVerdict;
}

type PermissionResolution =
  | { readonly resolution: 'aborted' | 'denied' | 'timeout' }
  | { readonly resolution: 'approved'; readonly scope: 'once' | 'session' };

interface PermissionRequest extends GateRequest {
  readonly expiresAt: Date;
  readonly reason: string;
  readonly requestId: string;
  readonly requestedAt: Date;
  readonly signals: readonly RiskSignal[];
}

interface PendingPermission {
  /** False when the per-principal pending limit closed the decision immediately. */
  readonly accepted: boolean;
  readonly outcome: Promise<PermissionResolution>;
  readonly request: PermissionRequest;
}

interface GateAuditRecord extends GateRequest {
  readonly createdAt: Date;
  readonly resolvedBy?: PrincipalRef;
  readonly decidedBy: string;
  readonly decisionId: string;
  readonly reason: string;
  readonly resolution?: PermissionResolution['resolution'];
  readonly resolvedAt?: Date;
  readonly scope?: 'once' | 'session';
  readonly signals: readonly RiskSignal[];
  readonly verdict: GateVerdict;
}

interface GateAuditSink {
  record(record: GateAuditRecord): void;
  resolve(
    decisionId: string,
    resolution: PermissionResolution,
    resolvedAt: Date,
    resolvedBy?: PrincipalRef,
  ): void;
}

export type {
  GateAuditRecord,
  GateAuditSink,
  GateDecision,
  GateEvaluation,
  GateEvaluator,
  GateRequest,
  GateVerdict,
  PendingPermission,
  PermissionRequest,
  PermissionResolution,
  RiskSignal,
};
