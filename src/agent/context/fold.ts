import { nanoid } from 'nanoid';

import { freezeMessage } from './immutable';

import type {
  AssistantMessage,
  FoldedMessage,
  Message,
  ToolCallMessage,
  ToolResponseMessage,
} from '../../provider';

interface FoldResult {
  history: Message[];
  events: FoldedMessage[];
}

interface FoldAccumulator {
  calls: Map<string, ToolCallMessage[]>;
  responses: Map<string, ToolResponseMessage[]>;
  messageIds: string[];
}

const SEPARATOR = '- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -';

function applyFold(history: readonly Message[], fold: FoldedMessage): Message[] {
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
    throw new Error(
      `Fold ${fold.messageId} anchor ${fold.anchorMessageId} is not an assistant message.`,
    );
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

function responseSize(response: ToolResponseMessage): string {
  return `${Buffer.byteLength(JSON.stringify(response.response))} bytes`;
}

function renderCall(call: ToolCallMessage, response: ToolResponseMessage | undefined): string {
  return `Tool Name: ${call.name}`
    + `\nTrack Id: ${call.trackId}`
    + `\nArguments: ${JSON.stringify(call.arguments)}`
    + `\nWas Error: ${response?.isError ?? 'unknown'}`
    + `\nWas Deferred: ${response?.execution === 'deferredAck'}`
    + `\nResponse Size: ${response === undefined ? 'n/a' : responseSize(response)}`;
}

function renderOrphanResponse(response: ToolResponseMessage): string {
  return `Unmatched Tool Response: ${response.name}`
    + `\nTrack Id: ${response.trackId}`
    + `\nWas Error: ${response.isError ?? 'unknown'}`
    + `\nWas Deferred: ${response.execution === 'deferredAck'}`
    + `\nResponse Size: ${responseSize(response)}`;
}

function renderFold({ calls, responses }: FoldAccumulator): string {
  const entries: string[] = [];

  for (const [trackId, trackCalls] of calls) {
    const trackResponses = responses.get(trackId) ?? [];
    for (const [index, call] of trackCalls.entries()) {
      entries.push(renderCall(call, trackResponses[index]));
    }
  }

  for (const [trackId, trackResponses] of responses) {
    const pairedCount = calls.get(trackId)?.length ?? 0;
    for (const response of trackResponses.slice(pairedCount)) {
      entries.push(renderOrphanResponse(response));
    }
  }

  return ['-----The following tool calls and responses have been folded-----']
    .concat(entries.map((entry) => `${entry}\n${SEPARATOR}`))
    .join('\n');
}

function trackedPush<T>(tracked: Map<string, T[]>, trackId: string, message: T): void {
  const existing = tracked.get(trackId);
  if (existing === undefined) tracked.set(trackId, [message]);
  else existing.push(message);
}

function createAccumulator(): FoldAccumulator {
  return { calls: new Map(), messageIds: [], responses: new Map() };
}

function isEmpty(accumulator: FoldAccumulator): boolean {
  return accumulator.calls.size === 0 && accumulator.responses.size === 0;
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

function foldHistory(
  history: readonly Message[],
  fromMessageId?: string,
  toMessageId?: string,
): FoldResult {
  const from = resolveIndex(history, fromMessageId, 0);
  const to = resolveIndex(history, toMessageId, history.length - 1);
  if (to < from) {
    throw new Error('Fold range ends before it starts.');
  }

  const events: FoldedMessage[] = [];
  let accumulator = createAccumulator();
  let anchor = history
    .slice(0, from)
    .findLast((message): message is AssistantMessage => message.role === 'assistant');

  const flush = (): void => {
    if (isEmpty(accumulator)) return;
    if (anchor === undefined) {
      throw new Error('No anchor assistant message found for folding tool calls and responses.');
    }

    events.push(freezeMessage<FoldedMessage>({
      anchorMessageId: anchor.messageId,
      content: [{ text: renderFold(accumulator), type: 'text' }],
      createdAt: new Date(),
      foldedMessageIds: accumulator.messageIds,
      messageId: nanoid(),
      role: 'folded',
    }));
    accumulator = createAccumulator();
  };

  for (const message of history.slice(from, to + 1)) {
    if (message.role === 'toolCall') {
      trackedPush(accumulator.calls, message.trackId, message);
      accumulator.messageIds.push(message.messageId);
      continue;
    }

    if (message.role === 'toolResponse') {
      if (message.execution === 'deferredResult') continue;
      trackedPush(accumulator.responses, message.trackId, message);
      accumulator.messageIds.push(message.messageId);
      continue;
    }

    if (message.role !== 'assistant') continue;

    flush();
    anchor = message;
  }

  flush();

  let folded: Message[] = [...history];
  for (const event of events) {
    folded = applyFold(folded, event);
  }

  return { events, history: folded };
}

export {
  applyFold,
  foldHistory,
};

export type {
  FoldResult,
};
