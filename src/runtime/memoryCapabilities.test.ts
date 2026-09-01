import { describe, expect, test } from 'bun:test';

import { memoryCapabilityMismatch } from './configurationRuntime';

describe('a memory and its contribution agreeing about editing', () => {
  test('says nothing when the declaration matches the instance', () => {
    expect(
      memoryCapabilityMismatch('recall', 'semantic', { declaresTools: true, hasEditor: true }),
    ).toBeUndefined();
    expect(
      memoryCapabilityMismatch('recall', 'semantic', { declaresTools: false, hasEditor: false }),
    ).toBeUndefined();
  });

  // The direction that used to slip through: configuration is validated against
  // the declaration, so a blueprint granting memory tools passed, and the agent
  // then refused to compose against an instance with nothing to edit.
  test('catches a declaration the instance does not honour', () => {
    const problem = memoryCapabilityMismatch('recall', 'semantic', {
      declaresTools: true,
      hasEditor: false,
    });

    expect(problem).toContain('exposes no editor');
    expect(problem).toContain('"recall"');
    expect(problem).toContain('semantic');
  });

  // The other direction matters too, and is not merely tidiness: an editor no
  // declaration mentions can never be granted, so it is a capability that
  // silently does nothing — which is the failure this whole model exists to
  // make impossible.
  test('catches an editor nothing declared', () => {
    const problem = memoryCapabilityMismatch('recall', 'semantic', {
      declaresTools: false,
      hasEditor: true,
    });

    expect(problem).toContain('does not declare support');
  });
});
