import type { GateRule } from './config';
import type { GateEvaluation, GateEvaluator, GateRequest } from './types';

interface CompiledRule {
  readonly match?: readonly { parameter: string; pattern: RegExp }[];
  readonly reason: string;
  readonly tools: '*' | ReadonlySet<string>;
  readonly toolSets: '*' | ReadonlySet<string>;
  readonly verdict: GateRule['verdict'];
}

const VERDICT_STRENGTH = { allow: 1, escalate: 2, deny: 3 } as const;

function matches(rule: CompiledRule, request: GateRequest): boolean {
  if (rule.tools !== '*' && !rule.tools.has(request.toolName)) return false;
  if (rule.toolSets !== '*' && !rule.toolSets.has(request.toolSetId)) return false;

  return (rule.match ?? []).every(({ parameter, pattern }) => {
    const value = request.params[parameter];
    if (value === undefined) return false;
    return pattern.test(typeof value === 'string' ? value : JSON.stringify(value));
  });
}

class RuleEvaluator implements GateEvaluator {
  public readonly id = 'rules';

  readonly #rules: readonly CompiledRule[];

  constructor(rules: readonly GateRule[]) {
    this.#rules = rules.map((rule) => ({
      match: Object.entries(rule.match ?? {}).map(([parameter, source]) => ({
        parameter,
        pattern: new RegExp(source),
      })),
      reason: rule.reason,
      tools: rule.tools === '*' ? '*' : new Set(rule.tools),
      toolSets: rule.toolSets === '*' ? '*' : new Set(rule.toolSets),
      verdict: rule.verdict,
    }));
  }

  public evaluate(request: GateRequest): GateEvaluation {
    const matching = this.#rules.filter((rule) => matches(rule, request));
    const strongest = matching.reduce<CompiledRule | undefined>((selected, candidate) => {
      if (selected === undefined) return candidate;
      return VERDICT_STRENGTH[candidate.verdict] > VERDICT_STRENGTH[selected.verdict]
        ? candidate
        : selected;
    }, undefined);

    return strongest === undefined
      ? { verdict: 'abstain' }
      : { reason: strongest.reason, verdict: strongest.verdict };
  }
}

export { RuleEvaluator };
