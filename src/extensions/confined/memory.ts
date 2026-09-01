import type { MemoryCapabilities } from './memoryServer';
import type { ToolSetChannel } from './toolSet';
import type {
  Memory,
  MemoryBlocks,
  MemoryEditor,
  MemoryInspector,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemoryRetainRequest,
  MemoryScopeInspection,
} from '@nox/extension-api';

let nextCallId = 0;

/**
 * Sends one memory call and keeps its cancellation wired.
 *
 * The signal is stripped — it cannot cross — and replaced by an id the far side
 * can be told to abort. Everything else in the request is data the contract
 * already defined as data.
 */
async function call(
  channel: ToolSetChannel,
  method: string,
  request: object,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const callId = `memory-${String(++nextCallId)}`;
  const { signal: _dropped, ...rest } = request as { signal?: unknown };
  const onAbort = (): void => {
    void channel.invoke('memory.abort', callId).catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await channel.invoke(`memory.${method}`, { ...rest, callId });
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * A memory whose storage, extraction and retrieval are in another process.
 *
 * Built by asking the far side which optional surfaces it has, rather than
 * offering all three. Absence is meaningful in this contract — a memory with no
 * `editor` cannot be granted Nox's editing tools, and one with no `blocks`
 * contributes nothing to the system prompt — so a proxy that always looked
 * complete would hand an extension surfaces it never implemented, and the
 * failure would arrive as a tool call that throws in the middle of somebody's
 * conversation.
 */
async function connectMemory(channel: ToolSetChannel): Promise<Memory> {
  const capabilities = (await channel.invoke('memory.capabilities')) as MemoryCapabilities;

  const blocks: MemoryBlocks = {
    read: async (request) => (await call(channel, 'blocks.read', request, request.signal)) as never,
    write: async (request) =>
      (await call(channel, 'blocks.write', request, request.signal)) as never,
  };

  const editor: MemoryEditor = {
    forget: async (request) =>
      (await call(channel, 'editor.forget', request, request.signal)) as never,
    search: async (request) =>
      (await call(channel, 'editor.search', request, request.signal)) as never,
    update: async (request) =>
      (await call(channel, 'editor.update', request, request.signal)) as never,
    write: async (request) =>
      (await call(channel, 'editor.write', request, request.signal)) as never,
  };

  const inspector: MemoryInspector = {
    episodes: async (request) =>
      (await call(channel, 'inspector.episodes', request, request.signal)) as never,
    facts: async (request) =>
      (await call(channel, 'inspector.facts', request, request.signal)) as never,
    scopes: async (signal): Promise<readonly MemoryScopeInspection[]> =>
      (await call(channel, 'inspector.scopes', {}, signal)) as readonly MemoryScopeInspection[],
  };

  return Object.freeze({
    ...(capabilities.blocks ? { blocks } : {}),
    ...(capabilities.editor ? { editor } : {}),
    ...(capabilities.inspector ? { inspector } : {}),
    recall: async (request: MemoryRecallRequest): Promise<MemoryRecallResult> =>
      (await call(channel, 'recall', request, request.signal)) as MemoryRecallResult,
    retain: async (request: MemoryRetainRequest): Promise<void> => {
      // No signal on this one: retention is what happens after a run ends, and
      // the contract gives it nothing to cancel with.
      await call(channel, 'retain', request, undefined);
    },
  });
}

export { connectMemory };
