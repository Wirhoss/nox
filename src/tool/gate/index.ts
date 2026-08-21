export { gatePolicySchema, gateRuleSchema, heuristicPolicySchema } from './config';
export { SessionGate } from './gate';
export { RiskHeuristicEvaluator } from './heuristics';
export { RuleEvaluator } from './rules';

export type { GatePolicy, GatePolicyInput, GateRule } from './config';
export type { SessionGateOptions } from './gate';
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
} from './types';
