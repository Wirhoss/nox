const MEMORY_TOOL_NAMES = [
  'memory_search',
  'memory_write',
  'memory_update',
  'memory_forget',
  'memory_block_write',
] as const;

/**
 * The tool that rewrites an always-present block.
 *
 * Named here rather than inline because the system prompt has to tell the agent
 * what to call to keep its blocks current, and a prompt naming a tool that was
 * renamed underneath it is a instruction the model cannot follow.
 */
const MEMORY_BLOCK_WRITE_TOOL_NAME = 'memory_block_write';

type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];

export { MEMORY_BLOCK_WRITE_TOOL_NAME, MEMORY_TOOL_NAMES };

export type { MemoryToolName };
