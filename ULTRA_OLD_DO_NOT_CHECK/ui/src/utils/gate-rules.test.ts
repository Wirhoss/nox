import { describe, expect, test } from 'bun:test';

import { parseRule, toEditableRule } from './gate-rules';

import type { EditableRule } from './gate-rules';

const editable = (overrides: Partial<EditableRule> = {}): EditableRule => ({
  match: '',
  reason: 'Approval is required.',
  tools: '*',
  verdict: 'escalate',
  ...overrides,
});

describe('toEditableRule', () => {
  test('renders the wildcard and lists in the form the field accepts', () => {
    expect(toEditableRule({ reason: 'r', tools: '*', verdict: 'deny' }).tools).toBe('*');
    expect(toEditableRule({ reason: 'r', tools: ['shell', 'search'], verdict: 'deny' }).tools)
      .toBe('shell, search');
  });

  test('leaves the condition field empty when the rule has no match', () => {
    expect(toEditableRule({ reason: 'r', tools: '*', verdict: 'deny' }).match).toBe('');
    expect(toEditableRule({ match: { path: '^/etc/' }, reason: 'r', tools: '*', verdict: 'deny' }).match)
      .toBe('{"path":"^/etc/"}');
  });
});

describe('parseRule', () => {
  test('round-trips a rule through its editable form', () => {
    const rule = { match: { path: '^/etc/' }, reason: 'Protected', tools: ['shell'], verdict: 'deny' as const };

    expect(parseRule(toEditableRule(rule), 0)).toEqual(rule);
  });

  test('splits a tool list and drops blank entries', () => {
    expect(parseRule(editable({ tools: 'shell, , search ' }), 0).tools).toEqual(['shell', 'search']);
  });

  test('omits match entirely when no conditions are given', () => {
    expect(parseRule(editable(), 0)).not.toHaveProperty('match');
  });

  test('names the offending policy by its position', () => {
    expect(() => parseRule(editable({ reason: '  ' }), 4)).toThrow('Policy 5 needs a reason.');
    expect(() => parseRule(editable({ tools: ' , ' }), 0)).toThrow('Policy 1 needs at least one tool name.');
  });

  test('rejects conditions that are not an object of strings', () => {
    expect(() => parseRule(editable({ match: '{' }), 0)).toThrow('invalid condition JSON');
    expect(() => parseRule(editable({ match: '["a"]' }), 0)).toThrow('JSON object of regular-expression strings');
    expect(() => parseRule(editable({ match: '{"path":3}' }), 0)).toThrow('JSON object of regular-expression strings');
  });

  test('rejects a condition that is not a compilable regular expression', () => {
    expect(() => parseRule(editable({ match: '{"path":"^([a-z"}' }), 0))
      .toThrow('contains an invalid regular expression');
  });
});
