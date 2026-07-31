import type { GateRule } from '../config';
import type { GateEvaluator, GateRequest, GateVerdict } from '../types';

interface CompiledRule {
  tools: '*' | Set<string>;
  toolSets: '*' | Set<string>;
  match?: Array<{ parameter: string; pattern: RegExp }>;
  verdict: 'allow' | 'deny' | 'escalate';
  reason: string;
}

function asRecord(params: unknown): Record<string, unknown> {
  return params !== null && typeof params === 'object'
    ? params as Record<string, unknown>
    : {};
}

class RuleEvaluator implements GateEvaluator {
  public readonly id = 'rules';

  readonly #rules: CompiledRule[];

  constructor(declarations: readonly GateRule[]) {
    this.#rules = declarations.map((rule) => ({
      match: rule.match === undefined
        ? undefined
        : Object.entries(rule.match).map(([parameter, source]) => ({
          parameter,
          pattern: new RegExp(source),
        })),
      reason: rule.reason,
      toolSets: rule.toolSets === '*' ? '*' : new Set(rule.toolSets),
      tools: rule.tools === '*' ? '*' : new Set(rule.tools),
      verdict: rule.verdict,
    }));
  }

  public evaluate(request: GateRequest): GateVerdict {
    let escalation: CompiledRule | undefined;
    let approval: CompiledRule | undefined;

    for (const rule of this.#rules) {
      if (!RuleEvaluator.#matches(rule, request)) continue;

      if (rule.verdict === 'deny') {
        return { reason: rule.reason, verdict: 'deny' };
      }
      if (rule.verdict === 'escalate') {
        escalation ??= rule;
      } else {
        approval ??= rule;
      }
    }

    if (escalation !== undefined) {
      return { reason: escalation.reason, verdict: 'escalate' };
    }
    if (approval !== undefined) {
      return { reason: approval.reason, verdict: 'allow' };
    }
    return { verdict: 'abstain' };
  }

  static #matches(rule: CompiledRule, request: GateRequest): boolean {
    if (rule.tools !== '*' && !rule.tools.has(request.entry.tool.name)) {
      return false;
    }
    if (rule.toolSets !== '*' && !rule.toolSets.has(request.entry.toolSetId)) {
      return false;
    }
    if (rule.match === undefined) {
      return true;
    }

    const params = asRecord(request.params);
    return rule.match.every(({ parameter, pattern }) => {
      const value = params[parameter];
      if (value === undefined) return false;
      return pattern.test(typeof value === 'string' ? value : JSON.stringify(value));
    });
  }
}

export {
  RuleEvaluator,
};
