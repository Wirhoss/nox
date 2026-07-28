import { nanoid } from 'nanoid';

import type {
  AssistantMessage,
  CompactionMessage,
  FoldMessage,
  Message,
  ToolCallMessage,
  ToolResponseMessage,
} from '../../provider';

interface FoldRange {
  fromMessageId?: string;
  toMessageId?: string;
}

interface FoldResult {
  history: Message[];
  events: FoldMessage[];
}

function isSafeCut(history: readonly Message[], index: number): boolean {
  if (index <= 0 || index >= history.length) return true;
  if (history[index - 1]?.role === 'toolCall') return false;
  if (history[index]?.role === 'toolResponse') return false;
  return true;
}

function seekSafeCut(history: readonly Message[], from: number, direction: 1 | -1): number {
  let index = Math.max(0, Math.min(from, history.length));
  while (index > 0 && index < history.length && !isSafeCut(history, index)) {
    index += direction;
  }
  return Math.max(0, Math.min(index, history.length));
}

function applyCompaction(history: readonly Message[], compaction: CompactionMessage): Message[] {
  const replacedIds = new Set(compaction.replacedMessageIds);
  if (replacedIds.size === 0) {
    throw new Error(`Compaction ${compaction.messageId} does not replace any messages.`);
  }
  if (replacedIds.size !== compaction.replacedMessageIds.length) {
    throw new Error(`Compaction ${compaction.messageId} contains duplicate message references.`);
  }
  if (replacedIds.has(compaction.messageId)) {
    throw new Error(`Compaction ${compaction.messageId} cannot replace itself.`);
  }

  const indexes: number[] = [];
  const foundIds = new Set<string>();
  for (const [index, message] of history.entries()) {
    if (!replacedIds.has(message.messageId)) continue;
    indexes.push(index);
    foundIds.add(message.messageId);
  }

  if (foundIds.size !== replacedIds.size) {
    const missingIds = compaction.replacedMessageIds.filter((messageId) => !foundIds.has(messageId));
    throw new Error(
      `Compaction ${compaction.messageId} references missing messages: ${missingIds.join(', ')}.`,
    );
  }

  const start = indexes[0]!;
  const end = indexes[indexes.length - 1]! + 1;
  if (end - start !== indexes.length) {
    throw new Error(`Compaction ${compaction.messageId} references a non-contiguous message range.`);
  }

  return [
    ...history.slice(0, start),
    compaction,
    ...history.slice(end),
  ];
}

// Replays one recorded fold: the folded messages leave the history and the fold
// takes their place. The anchor is left untouched — how a fold is rendered is
// the provider's call, so `anchorMessageId` only says where it belongs.
//
// `foldHistory` produces its own output through this same function, so a live
// fold and a rebuilt fold cannot drift: any drift would change the bytes sent to
// the provider and invalidate the whole prompt cache.
function applyFold(history: readonly Message[], fold: FoldMessage): Message[] {
  const foldedIds = new Set(fold.foldedMessageIds);
  if (foldedIds.size === 0) {
    throw new Error(`Fold ${fold.messageId} does not fold any messages.`);
  }
  if (foldedIds.size !== fold.foldedMessageIds.length) {
    throw new Error(`Fold ${fold.messageId} contains duplicate message references.`);
  }
  if (foldedIds.has(fold.messageId)) {
    throw new Error(`Fold ${fold.messageId} cannot fold itself.`);
  }
  if (foldedIds.has(fold.anchorMessageId)) {
    throw new Error(`Fold ${fold.messageId} cannot fold its own anchor ${fold.anchorMessageId}.`);
  }

  const anchorIndex = history.findIndex((message) => message.messageId === fold.anchorMessageId);
  if (anchorIndex === -1) {
    throw new Error(`Fold ${fold.messageId} references a missing anchor ${fold.anchorMessageId}.`);
  }
  if (history[anchorIndex]?.role !== 'assistant') {
    throw new Error(`Fold ${fold.messageId} anchor ${fold.anchorMessageId} is not an assistant message.`);
  }

  const foundIds = new Set<string>();
  const folded: Message[] = [];
  let placed = false;

  for (const [index, message] of history.entries()) {
    if (!foldedIds.has(message.messageId)) {
      folded.push(message);
      continue;
    }
    if (index < anchorIndex) {
      throw new Error(
        `Fold ${fold.messageId} folds ${message.messageId}, which precedes its anchor.`,
      );
    }
    foundIds.add(message.messageId);
    // A deferred result can sit between a call and its response, so the folded
    // messages are not always contiguous. The fold lands on the first of them.
    if (!placed) {
      folded.push(fold);
      placed = true;
    }
  }

  if (foundIds.size !== foldedIds.size) {
    const missingIds = fold.foldedMessageIds.filter((messageId) => !foundIds.has(messageId));
    throw new Error(`Fold ${fold.messageId} references missing messages: ${missingIds.join(', ')}.`);
  }

  return folded;
}

function renderFold(
  toolCallMessages: ReadonlyMap<string, ToolCallMessage>,
  toolResponseMessages: ReadonlyMap<string, ToolResponseMessage>,
): string {
  let toolFoldedMessage = '-----The following tool calls and responses have been folded-----';
  for (const toolCallMessage of toolCallMessages.values()) {
    const response = toolResponseMessages.get(toolCallMessage.trackId);
    toolFoldedMessage += `\nTool Name: ${toolCallMessage.name}`
      + `\nTrack Id: ${toolCallMessage.trackId}`
      + `\nArguments: ${JSON.stringify(toolCallMessage.arguments)}`
      + `\nWas Error: ${response?.isError ?? 'unknown'}`
      + `\nWas Deferred: ${response?.execution === 'deferredAck'}`
      + `\nReponse Size: ${response?.response ? Buffer.byteLength(JSON.stringify(response?.response)) + ' bytes' : 'n/a'}`
      + '\n- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -';
  }
  return toolFoldedMessage;
}

function resolveIndex(
  history: readonly Message[],
  messageId: string | undefined,
  fallback: number,
): number {
  if (messageId === undefined) return fallback;
  const index = history.findIndex((message) => message.messageId === messageId);
  if (index === -1) {
    throw new Error(`Fold range references a missing message ${messageId}.`);
  }
  return index;
}

// Replaces the tool traffic inside `range` (the whole history when omitted)
// with one fold per tool group. The runner knows the boundaries of the turn it
// just completed, so scoping the fold keeps the edit off the part of the
// history the provider has already cached.
function foldHistory(history: readonly Message[], range: FoldRange = {}): FoldResult {
  const from = resolveIndex(history, range.fromMessageId, 0);
  const to = resolveIndex(history, range.toMessageId, history.length - 1);
  if (to < from) {
    throw new Error('Fold range ends before it starts.');
  }

  const events: FoldMessage[] = [];

  const toolCallMessages: Map<string, ToolCallMessage> = new Map();
  const toolResponseMessages: Map<string, ToolResponseMessage> = new Map();
  let foldedMessageIds: string[] = [];
  let anchor: AssistantMessage | undefined;

  for (const message of history.slice(from, to + 1)) {
    if (message.role === 'toolCall') {
      toolCallMessages.set(message.trackId, message);
      foldedMessageIds.push(message.messageId);
      continue;
    }

    if (message.role === 'toolResponse') {
      // A deferred result arrives long after its call and stays in the active
      // history on its own, so it is never part of a fold.
      if (message.execution === 'deferredResult') continue;
      toolResponseMessages.set(message.trackId, message);
      foldedMessageIds.push(message.messageId);
      continue;
    }

    if (message.role !== 'assistant') continue;

    // An assistant turn closes the tool group that ran before it.
    if (toolCallMessages.size > 0) {
      if (anchor === undefined) {
        throw new Error('No anchor assistant message found for folding tool calls and responses.');
      }
      events.push(Object.freeze<FoldMessage>({
        role: 'fold',
        anchorMessageId: anchor.messageId,
        content: [{ type: 'text', text: renderFold(toolCallMessages, toolResponseMessages) }],
        createdAt: new Date(),
        foldedMessageIds: Object.freeze(foldedMessageIds),
        messageId: nanoid(),
      }));
      toolCallMessages.clear();
      toolResponseMessages.clear();
      foldedMessageIds = [];
    }

    anchor = message;
  }

  if (toolCallMessages.size > 0 || toolResponseMessages.size > 0) {
    throw new Error('Remaining tool call or response messages found after folding context. This should not happen.');
  }

  let folded: Message[] = [...history];
  for (const event of events) {
    folded = applyFold(folded, event);
  }

  return { events, history: folded };
}

export {
  applyCompaction,
  applyFold,
  foldHistory,
  isSafeCut,
  seekSafeCut,
};

export type {
  FoldRange,
  FoldResult,
};
