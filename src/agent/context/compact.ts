import type { CompactedMessage, Message } from '@nox/extension-api';

function isSafeCut(history: readonly Message[], index: number): boolean {
  if (index <= 0 || index >= history.length) return true;
  if (history[index - 1]?.role === 'toolCall') return false;
  if (history[index]?.role === 'toolResponse') return false;
  return true;
}

function seekSafeCut(history: readonly Message[], from: number, direction: -1 | 1): number {
  let index = Math.max(0, Math.min(from, history.length));
  while (index > 0 && index < history.length && !isSafeCut(history, index)) {
    index += direction;
  }
  return Math.max(0, Math.min(index, history.length));
}

function applyCompaction(history: readonly Message[], compaction: CompactedMessage): Message[] {
  const replacedIds = new Set(compaction.compactedMessageIds);
  if (replacedIds.size === 0) {
    throw new Error(`Compaction ${compaction.messageId} does not replace any messages.`);
  }
  if (replacedIds.size !== compaction.compactedMessageIds.length) {
    throw new Error(`Compaction ${compaction.messageId} contains duplicate message references.`);
  }
  if (replacedIds.has(compaction.messageId)) {
    throw new Error(`Compaction ${compaction.messageId} cannot replace itself.`);
  }

  const foundIds = new Set<string>();
  let start = -1;
  let end = -1;
  for (const [index, message] of history.entries()) {
    if (!replacedIds.has(message.messageId)) continue;
    if (start === -1) start = index;
    end = index + 1;
    foundIds.add(message.messageId);
  }

  if (foundIds.size !== replacedIds.size) {
    const missingIds = compaction.compactedMessageIds.filter(
      (messageId) => !foundIds.has(messageId),
    );
    throw new Error(
      `Compaction ${compaction.messageId} references missing messages: ${missingIds.join(', ')}.`,
    );
  }

  if (end - start !== foundIds.size) {
    throw new Error(
      `Compaction ${compaction.messageId} references a non-contiguous message range.`,
    );
  }

  return [...history.slice(0, start), compaction, ...history.slice(end)];
}

export { applyCompaction, seekSafeCut };
