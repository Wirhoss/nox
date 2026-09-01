import {
  ARTIFACT_OUTPUT_NOTICE,
  bindSetTool,
  declareTool,
  prepareToolCall,
  renderTool,
  toolDescription,
  ToolSet,
  UnknownToolError,
} from '@nox/extension-api';
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

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

describe('one rendering, wherever a tool is described', () => {
  // There used to be two renderers: the rich one the catalogue showed, and a
  // raw JSON Schema dump used by the invalid-params error — under a heading
  // that said "Expected signature". A model being corrected was corrected in a
  // notation it had never been taught. This is what keeps them the same.
  test('the signature in a params error is the catalogue rendering', async () => {
    const source = tool(false);

    const failure = await prepareToolCall(source, { format: 'docx' }).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(failure?.message).toContain(renderTool(source));
  });
});

describe('what a prepared call hands the host', () => {
  function counting(): { readonly calls: () => number; readonly source: Tool } {
    let calls = 0;
    const source: Tool = {
      authority: 'test.tool',
      description: 'Count how often it was run.',
      name: 'count',
      parameters: z.object({}),
      prepare: () => ({
        // Not part of the contract. It rides along to prove the host is handed
        // a constructed shape rather than whatever object the tool returned.
        internalBookkeeping: 'private to the tool',
        preview: 'about to count',
        run: () => {
          calls += 1;
          return Promise.resolve([]);
        },
        title: 'Count',
        type: 'immediate' as const,
      }),
    };
    return { calls: () => calls, source };
  }

  // The point of the split: a host holding a prepared call is holding something
  // a transport could have built for it, not the object the tool returned.
  // Closures do not cross a process boundary; this one never has to.
  test('is not the object the tool returned, and cannot be edited after the fact', async () => {
    const { source } = counting();
    const returnedByTheTool = await source.prepare({});
    expect(returnedByTheTool).toHaveProperty('internalBookkeeping');

    const prepared = await prepareToolCall(source, {});

    expect(prepared).not.toHaveProperty('internalBookkeeping');
    expect(Object.keys(prepared).sort()).toEqual(['params', 'preview', 'run', 'title', 'type']);
    expect(Object.isFrozen(prepared)).toBeTrue();
  });

  test('carries the descriptive half as plain data, under the same names', async () => {
    const { source } = counting();

    const prepared = await prepareToolCall(source, {});

    expect(prepared.type).toBe('immediate');
    expect(prepared.title).toBe('Count');
    expect(prepared.preview).toBe('about to count');
    expect(prepared.params).toEqual({});
  });

  // Describing a call must not perform it. The runner reads the descriptive
  // half to decide whether the call may happen at all, and that decision comes
  // first — a preparation with an effect would have already acted.
  test('preparing does not run anything', async () => {
    const { calls, source } = counting();

    const prepared = await prepareToolCall(source, {});
    expect(calls()).toBe(0);

    await prepared.run({ abortSignal: new AbortController().signal });
    expect(calls()).toBe(1);
  });
});

describe('a tool as a reader sees it', () => {
  // Everything that only reads a tool — rendering, token accounting, search
  // indexing, the provider request — wants the same conversion of the same
  // declaration. Doing it per read is how two readers end up disagreeing, and
  // it is the work the host will not be able to do at all once the Zod object
  // lives in another process.
  test('carries no schema object, only its conversion', () => {
    const declared = declareTool(tool(false));

    expect(declared.parameters).toEqual({
      properties: { format: { enum: ['csv', 'pdf'], type: 'string' } },
      required: ['format'],
      type: 'object',
    });
    expect(Object.isFrozen(declared)).toBeTrue();
  });

  test('describes the tool the way the model is told, notice included', () => {
    expect(declareTool(tool(true)).description).toContain(ARTIFACT_OUTPUT_NOTICE);
    expect(declareTool(tool(false)).description).toBe('Build a report from the selected records.');
  });

  // Converted once per tool. The token estimator reads every tool in the table
  // on every estimate, so a fresh conversion each time is paid per turn.
  test('is computed once and handed back', () => {
    const source = tool(false);

    expect(declareTool(source)).toBe(declareTool(source));
  });
});

describe('reaching a granted tool set', () => {
  class Reporting extends ToolSet {
    public readonly preparedBySet: string[] = [];

    constructor() {
      super('Reporting', 'Builds reports.');
      this.addTools();
    }

    protected override addTools(): void {
      this.registerTool({
        authority: 'test.tool',
        description: 'Build a report.',
        name: 'build',
        parameters: z.object({}),
        prepare: () => {
          this.preparedBySet.push('build');
          return { run: () => Promise.resolve([]), title: 'Build', type: 'immediate' as const };
        },
      });
    }
  }

  // The host reads a declaration and calls prepare by name. It never holds the
  // set's tool, which is exactly what it will not be able to hold when the set
  // is a proxy for something running elsewhere.
  test('goes through the set, never through its tools', async () => {
    const set = new Reporting();

    const bound = bindSetTool(set, 'build', 'reporting');
    const prepared = await bound.prepare({});

    expect(bound.declaration.name).toBe('build');
    expect(set.preparedBySet).toEqual(['build']);
    expect(prepared.gateSubject?.toolSetId).toBe('reporting');
  });

  test('a set declares what it exposes as data', () => {
    const declarations = new Reporting().declarations;

    expect(Object.keys(declarations)).toEqual(['build']);
    expect(declarations.build?.parameters).toEqual({ properties: {}, type: 'object' });
  });

  test('refuses a name the set does not expose', () => {
    expect(() => bindSetTool(new Reporting(), 'missing', 'reporting')).toThrow(UnknownToolError);
  });
});
