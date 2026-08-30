import {
  MEMORY_FACT_KINDS,
  type MemoryBlocks,
  type MemoryEditor,
  type MemoryScope,
  type MessageContent,
  stableStringify,
  type Tool,
  type ToolContext,
  ToolSet,
  type ToolSetGrant,
  z,
} from '@nox/extension-api';

import { MEMORY_READ_AUTHORITY, MEMORY_WRITE_AUTHORITY } from '../auth/coreAuthorities';
import { MEMORY_BLOCK_WRITE_TOOL_NAME, type MemoryToolName } from './memoryToolNames';

const MEMORY_TOOL_SET_ID = 'nox.memory';

function memoryScope(context: ToolContext): MemoryScope {
  const session = context.session;
  if (session === undefined) {
    throw new Error('Memory tools require an active agent session.');
  }
  return {
    agentId: session.agentId,
    metadata: session.metadata,
    principal: session.principal,
    sessionId: session.sessionId,
  };
}

function response(value: unknown): MessageContent[] {
  return [{ text: stableStringify(value), type: 'text' }];
}

function resource(action: string) {
  return { kind: 'command' as const, value: `memory/${action}` };
}

/** The stable host-owned tools backed by whichever editable memory the blueprint selected. */
class MemoryToolSet extends ToolSet {
  readonly #blockLabels: readonly string[];
  readonly #blocks?: MemoryBlocks;
  readonly #editor: MemoryEditor;

  constructor(editor: MemoryEditor, blocks?: MemoryBlocks, blockLabels?: readonly string[]) {
    super(
      'Long-term memory',
      "Search, write, correct, and retire facts in the current principal's long-term memory.",
    );
    // Assigned before addTools, which is what decides whether the block tool
    // exists at all.
    this.#blockLabels = Object.freeze([...(blockLabels ?? [])]);
    if (blocks !== undefined) this.#blocks = blocks;
    this.#editor = editor;
    this.addTools();
  }

  protected override addTools(): void {
    const searchParameters = z.object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(5)
        .describe('Maximum number of current facts to return.'),
      query: z
        .string()
        .trim()
        .min(1)
        .max(2_000)
        .describe('Meaning or subject to look for in long-term memory.'),
    });
    const search: Tool<typeof searchParameters> = {
      authority: MEMORY_READ_AUTHORITY,
      description:
        'Semantically search current long-term facts owned by the principal running this turn. Returns opaque fact IDs for later correction or retirement.',
      name: 'memory_search',
      parameters: searchParameters,
      prepare: ({ limit, query }) => ({
        run: async (context) => {
          context.abortSignal.throwIfAborted();
          const memories = await this.#editor.search({
            limit,
            query,
            scope: memoryScope(context),
            signal: context.abortSignal,
          });
          context.abortSignal.throwIfAborted();
          return response({ count: memories.length, memories });
        },
        title: `Search long-term memory — ${query}`,
        type: 'immediate',
      }),
      risk: {
        effects: ['read'],
        resources: [resource('search')],
        reversible: true,
      },
    };

    const writeParameters = z.object({
      // Closed, and to the same list the extractor picks from. A free string
      // here produced facts under kinds nothing else recognised — and because
      // consolidation only compares facts of one kind, those never merged with
      // the extracted statement of the very same claim.
      kind: z
        .enum(MEMORY_FACT_KINDS)
        .describe(
          'What sort of fact this is. identity: who they are and what does not change. ' +
            'preference: what they like or want done. decision: something settled that later ' +
            'work depends on. state: something true of them for now, which will change again.',
        ),
      text: z
        .string()
        .trim()
        .min(1)
        .max(4_000)
        .describe('Standalone factual statement to remember.'),
      validFrom: z.iso
        .datetime({ offset: true })
        .optional()
        .describe('When the statement became true; defaults to now.'),
    });
    const write: Tool<typeof writeParameters> = {
      authority: MEMORY_WRITE_AUTHORITY,
      description:
        "Write one explicit standalone fact to the current principal's long-term memory. Use only for information the user asked to preserve or clearly stated as durable.",
      name: 'memory_write',
      parameters: writeParameters,
      prepare: ({ kind, text, validFrom }) => ({
        preview: `[${kind}] ${text}`,
        risk: {
          effects: ['write'],
          resources: [resource('write')],
          reversible: true,
          volume: 1,
        },
        run: async (context) => {
          context.abortSignal.throwIfAborted();
          const memory = await this.#editor.write({
            kind,
            scope: memoryScope(context),
            signal: context.abortSignal,
            text,
            ...(validFrom === undefined ? {} : { validFrom }),
          });
          context.abortSignal.throwIfAborted();
          return response({ memory, written: true });
        },
        title: `Remember fact — ${kind}`,
        type: 'immediate',
      }),
      risk: { effects: ['write'], reversible: true },
    };

    const updateParameters = writeParameters.extend({
      id: z.string().trim().min(1).max(256).describe('Opaque fact ID returned by memory_search.'),
    });
    const update: Tool<typeof updateParameters> = {
      authority: MEMORY_WRITE_AUTHORITY,
      description:
        'Replace one current fact, by opaque ID, with a corrected statement in the same principal scope. The superseded version remains in the audit history.',
      name: 'memory_update',
      parameters: updateParameters,
      prepare: ({ id, kind, text, validFrom }) => ({
        preview: `${id}: [${kind}] ${text}`,
        risk: {
          effects: ['write'],
          resources: [resource(`facts/${id}`)],
          reversible: true,
          volume: 1,
        },
        run: async (context) => {
          context.abortSignal.throwIfAborted();
          const memory = await this.#editor.update({
            id,
            kind,
            scope: memoryScope(context),
            signal: context.abortSignal,
            text,
            ...(validFrom === undefined ? {} : { validFrom }),
          });
          context.abortSignal.throwIfAborted();
          return response({ id, memory: memory ?? null, updated: memory !== undefined });
        },
        title: `Correct memory fact — ${id}`,
        type: 'immediate',
      }),
      risk: { effects: ['write'], reversible: true },
    };

    const forgetParameters = z.object({
      id: z.string().trim().min(1).max(256).describe('Opaque fact ID returned by memory_search.'),
      validTo: z.iso
        .datetime({ offset: true })
        .optional()
        .describe('When the statement stopped being true; defaults to now.'),
    });
    const forget: Tool<typeof forgetParameters> = {
      authority: MEMORY_WRITE_AUTHORITY,
      description:
        'Retire one current fact from future recall in the same principal scope. This is an audited logical invalidation, not physical erasure.',
      name: 'memory_forget',
      parameters: forgetParameters,
      prepare: ({ id, validTo }) => ({
        risk: {
          effects: ['delete', 'write'],
          resources: [resource(`facts/${id}`)],
          reversible: false,
          volume: 1,
        },
        run: async (context) => {
          context.abortSignal.throwIfAborted();
          const forgotten = await this.#editor.forget({
            id,
            scope: memoryScope(context),
            signal: context.abortSignal,
            ...(validTo === undefined ? {} : { validTo }),
          });
          context.abortSignal.throwIfAborted();
          return response({ forgotten, id });
        },
        title: `Retire memory fact — ${id}`,
        type: 'immediate',
      }),
      risk: { effects: ['delete', 'write'], reversible: false },
    };

    this.registerTool(search);
    this.registerTool(write);
    this.registerTool(update);
    this.registerTool(forget);
    this.#addBlockTool();
  }

  /**
   * The tool that maintains the always-present blocks, when there are any.
   *
   * Registered only where the blueprint declared blocks and the memory can hold
   * them. A tool offered without either would be one the model can call and
   * nothing can satisfy, which reads to it as a capability that is simply
   * broken rather than one it was never given.
   */
  #addBlockTool(): void {
    const blocks = this.#blocks;
    const labels = this.#blockLabels;
    if (blocks === undefined || labels.length === 0) return;

    const blockParameters = z.object({
      label: z
        .enum(labels as [string, ...string[]])
        .describe('Which block to rewrite. Only the blocks listed in the system prompt exist.'),
      value: z
        .string()
        .trim()
        .max(2_000)
        .describe('The block’s complete new contents, which replace what it held.'),
    });
    const blockWrite: Tool<typeof blockParameters> = {
      authority: MEMORY_WRITE_AUTHORITY,
      description:
        'Replace the entire contents of one always-present memory block. The value given ' +
        'becomes the whole block, so include everything worth keeping: this overwrites ' +
        'rather than appends, and the previous contents are not retained.',
      name: MEMORY_BLOCK_WRITE_TOOL_NAME,
      parameters: blockParameters,
      prepare: ({ label, value }) => ({
        preview: `[${label}] ${value}`,
        risk: {
          effects: ['write'],
          resources: [resource(`blocks/${label}`)],
          // The only irreversible one of the memory tools. A fact it supersedes
          // stays readable as history; a block has no history to fall back to.
          reversible: false,
          volume: 1,
        },
        run: async (context) => {
          context.abortSignal.throwIfAborted();
          const block = await blocks.write({
            label,
            scope: memoryScope(context),
            signal: context.abortSignal,
            value,
          });
          context.abortSignal.throwIfAborted();
          return response({ block, written: true });
        },
        title: `Update memory block — ${label}`,
        type: 'immediate',
      }),
      risk: { effects: ['write'], reversible: false },
    };
    this.registerTool(blockWrite);
  }
}

function memoryToolSetGrant(
  editor: MemoryEditor,
  tools: readonly MemoryToolName[],
  blocks?: MemoryBlocks,
  blockLabels?: readonly string[],
): ToolSetGrant {
  return {
    toolSet: new MemoryToolSet(editor, blocks, blockLabels),
    toolSetId: MEMORY_TOOL_SET_ID,
    tools,
  };
}

export {
  MEMORY_READ_AUTHORITY,
  MEMORY_TOOL_SET_ID,
  MEMORY_WRITE_AUTHORITY,
  MemoryToolSet,
  memoryToolSetGrant,
};
