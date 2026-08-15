import type { ToolCallMessage } from '../provider';
import type { GateRule } from './config';

type GateVerdict =
  | { verdict: 'pass' }
  | { verdict: 'deny'; reason: string }
  | { verdict: 'escalate'; reason: string };

interface CompiledRule {
  tools: '*' | Set<string>;
  match?: Array<{ argument: string; pattern: RegExp }>;
  verdict: 'deny' | 'escalate';
  reason: string;
}

class ToolGate {
  private readonly rules: CompiledRule[];

  constructor(declarations: GateRule[]) {
    this.rules = declarations.map((rule) => ({
      tools: rule.tools === '*' ? '*' : new Set(rule.tools),
      match: rule.match === undefined
        ? undefined
        : Object.entries(rule.match).map(([argument, source]) => ({
          argument,
          pattern: new RegExp(source),
        })),
      verdict: rule.verdict,
      reason: rule.reason,
    }));
  }

  public evaluate(toolCall: ToolCallMessage): GateVerdict {
    let escalation: CompiledRule | undefined;
    for (const rule of this.rules) {
      if (!this.matches(rule, toolCall)) {
        continue;
      }
      if (rule.verdict === 'deny') {
        return { verdict: 'deny', reason: rule.reason };
      }
      escalation ??= rule;
    }
    return escalation === undefined
      ? { verdict: 'pass' }
      : { verdict: 'escalate', reason: escalation.reason };
  }

  private matches(rule: CompiledRule, toolCall: ToolCallMessage): boolean {
    if (rule.tools !== '*' && !rule.tools.has(toolCall.name)) {
      return false;
    }
    if (rule.match === undefined) {
      return true;
    }
    return rule.match.every(({ argument, pattern }) => {
      const value = toolCall.arguments[argument];
      if (value === undefined) {
        return false;
      }
      return pattern.test(typeof value === 'string' ? value : JSON.stringify(value));
    });
  }
}

export {
  ToolGate,
};

export type {
  GateVerdict,
};
