import type { ToolEntry } from '../registry';
import type { ToolExecution } from '../tool';

interface GateRequest {
  entry: ToolEntry;
  params: unknown;
  execution: ToolExecution;
  sessionId: string;
  abortSignal?: AbortSignal;
}

type GateVerdict =
  | { verdict: 'allow'; scope?: 'once' | 'session'; reason?: string }
  | { verdict: 'deny'; reason: string }
  | { verdict: 'escalate'; reason: string }
  /** No opinion — hand the request to the next evaluator. */
  | { verdict: 'abstain' };

type ReviewVerdict = Extract<
  GateVerdict,
  { verdict: 'abstain' | 'deny' | 'escalate' }
>;

type GateDecision =
  & Exclude<GateVerdict, { verdict: 'abstain' }>
  & { evaluatorId: string };

interface GateEvaluator {
  readonly id: string;
  evaluate(request: GateRequest): GateVerdict | Promise<GateVerdict>;
}

export type {
  GateDecision,
  GateEvaluator,
  GateRequest,
  GateVerdict,
  ReviewVerdict,
};
