import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { ARTIFACT_OUTPUT_NOTICE, renderTool, toolDescription } from './render';

import type { Tool } from '@nox/extension-api';

function tool(artifacts: boolean): Tool {
  return {
    authority: 'test.tool',
    description: 'Build a report from the selected records.',
    name: 'build_report',
    ...(artifacts ? { output: { artifacts: true as const } } : {}),
    parameters: z.object({ format: z.enum(['csv', 'pdf']) }),
    prepare: () => ({
      run: () => Promise.resolve([]),
      title: 'Build report',
      type: 'immediate',
    }),
  };
}

describe('tool output descriptions', () => {
  test('tells the model when a tool returns durable artifacts', () => {
    const source = tool(true);

    expect(toolDescription(source)).toBe(
      `Build a report from the selected records.\n\n${ARTIFACT_OUTPUT_NOTICE}`,
    );
    expect(renderTool(source)).toContain(ARTIFACT_OUTPUT_NOTICE);
  });

  test('does not advertise output a tool never declared', () => {
    const description = toolDescription(tool(false));

    expect(description).toBe('Build a report from the selected records.');
    expect(description).not.toContain('durable files');
  });
});
