/*
 * Conversion between a gate rule and its editable form.
 *
 * The gate stores `tools` as either the literal `"*"` or a list, and `match`
 * as an object of regular-expression sources. Both are edited as free text, so
 * every save has to parse and validate them before the config is sent — an
 * invalid regular expression accepted here would only fail later, inside the
 * gate, where the user cannot see it.
 *
 * `parseRule` reports problems by throwing, with messages naming the policy by
 * its position, because that is how the rules are labelled in the UI.
 */

import type { GateRule } from './types';

/** A gate rule while it is being edited: every field is raw text. */
type EditableRule = {
  tools: string;
  match: string;
  verdict: 'deny' | 'escalate';
  reason: string;
};

/** The rule a freshly added policy starts from: ask before every call. */
const NEW_RULE: EditableRule = {
  match: '',
  reason: 'Approval is required.',
  tools: '*',
  verdict: 'escalate',
};

function toEditableRule(rule: GateRule): EditableRule {
  return {
    match: rule.match ? JSON.stringify(rule.match) : '',
    reason: rule.reason,
    tools: rule.tools === '*' ? '*' : rule.tools.join(', '),
    verdict: rule.verdict,
  };
}

/**
 * Validates one edited policy and converts it back to wire form.
 *
 * @param index Zero-based position, used only to number the policy in errors.
 * @throws Error describing the first problem found.
 */
function parseRule(rule: EditableRule, index: number): GateRule {
  const label = `Policy ${index + 1}`;

  const targets = rule.tools.trim() === '*'
    ? '*' as const
    : rule.tools.split(',').map((tool) => tool.trim()).filter(Boolean);
  if (targets !== '*' && targets.length === 0) throw new Error(`${label} needs at least one tool name.`);
  if (!rule.reason.trim()) throw new Error(`${label} needs a reason.`);

  let match: Record<string, string> | undefined;
  if (rule.match.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rule.match);
    } catch {
      throw new Error(`${label} has invalid condition JSON.`);
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object'
      || Object.values(parsed).some((value) => typeof value !== 'string')) {
      throw new Error(`${label} conditions must be a JSON object of regular-expression strings.`);
    }
    match = parsed as Record<string, string>;
    try {
      // Compiled here so a bad pattern is reported against the field that
      // holds it, rather than failing inside the gate at call time.
      Object.values(match).forEach((source) => new RegExp(source));
    } catch {
      throw new Error(`${label} contains an invalid regular expression.`);
    }
  }

  return {
    tools: targets,
    ...(match ? { match } : {}),
    verdict: rule.verdict,
    reason: rule.reason.trim(),
  };
}

export {
  NEW_RULE,
  parseRule,
  toEditableRule,
};

export type {
  EditableRule,
};
