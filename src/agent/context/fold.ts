import { nanoid } from 'nanoid';

import { freezeMessage } from './immutable';

import type {
  AssistantMessage,
  FoldedMessage,
  Message,
  ToolCallMessage,
  ToolResponseMessage,
} from '@nox/extension-api';

interface FoldResult {
  events: FoldedMessage[];
  history: Message[];
}

interface FoldOptions {
  estimateTokens: (message: Message) => number;
  fromMessageId?: string;
  minReductionRatio?: number;
  toMessageId?: string;
}

interface FoldAccumulator {
  calls: Map<string, ToolCallMessage[]>;
  messages: Message[];
  responses: Map<string, ToolResponseMessage[]>;
}

const DEFAULT_MIN_REDUCTION_RATIO = 0.2;
const FOLDED_ENTRY_SEPARATOR = '\n---\n';
const MAX_FOLDED_ARGUMENT_CHARS = 200;

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

  const foundIds = new Set<string>();
  const folded: Message[] = [];
  let placed = false;

  for (const message of history) {
    if (!foldedIds.has(message.messageId)) {
      folded.push(message);
      continue;
    }
    foundIds.add(message.messageId);
    if (!placed) {
      folded.push(fold);
      placed = true;
    }
  }

  if (foundIds.size !== foldedIds.size) {
    const missingIds = fold.foldedMessageIds.filter((messageId) => !foundIds.has(messageId));
    throw new Error(
      `Fold ${fold.messageId} references missing messages: ${missingIds.join(', ')}.`,
    );
  }

  return folded;
}

function renderArguments(call: ToolCallMessage): string {
  const serialized = JSON.stringify(call.arguments);
  if (serialized.length <= MAX_FOLDED_ARGUMENT_CHARS) return serialized;
  return (
    serialized.slice(0, MAX_FOLDED_ARGUMENT_CHARS) +
    `… [truncated, ${String(serialized.length)} chars total]`
  );
}

function renderOutcome(response: ToolResponseMessage | undefined): string {
  if (response === undefined) return 'no response';
  return response.isError === true ? 'error' : 'ok';
}

function renderCall(call: ToolCallMessage, response: ToolResponseMessage | undefined): string {
  return (
    `Tool Name: ${call.name}` +
    `\nTrack ID: ${call.trackId}` +
    `\nArguments: ${renderArguments(call)}` +
    `\nOutcome: ${renderOutcome(response)}`
  );
}

function renderOrphanResponse(response: ToolResponseMessage): string {
  return (
    `Unmatched Tool Response: ${response.name}` +
    `\nTrack ID: ${response.trackId}` +
    `\nOutcome: ${renderOutcome(response)}`
  );
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

  return `-----Folded tool calls-----\n${entries.join(FOLDED_ENTRY_SEPARATOR)}`;
}

function trackedPush<T>(tracked: Map<string, T[]>, trackId: string, message: T): void {
  const existing = tracked.get(trackId);
  if (existing === undefined) tracked.set(trackId, [message]);
  else existing.push(message);
}

function createAccumulator(): FoldAccumulator {
  return { calls: new Map(), messages: [], responses: new Map() };
}

/**
 * A fold is only worth applying when it reclaims a real share of what it
 * replaces. Small mechanical traffic renders to a placeholder larger than the
 * two messages it stands in for, and applying it would spend the prefix cache
 * to grow the working set.
 */
function isWorthFolding(
  candidate: FoldedMessage,
  replaced: readonly Message[],
  estimateTokens: (message: Message) => number,
  minReductionRatio: number,
): boolean {
  const replacedTokens = replaced.reduce((total, message) => total + estimateTokens(message), 0);
  return estimateTokens(candidate) <= replacedTokens * (1 - minReductionRatio);
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

function foldHistory(history: readonly Message[], options: FoldOptions): FoldResult {
  const { estimateTokens } = options;
  const minReductionRatio = options.minReductionRatio ?? DEFAULT_MIN_REDUCTION_RATIO;

  const from = resolveIndex(history, options.fromMessageId, 0);
  const to = resolveIndex(history, options.toMessageId, history.length - 1);
  if (to < from) {
    throw new Error('Fold range ends before it starts.');
  }

  const events: FoldedMessage[] = [];
  let accumulator = createAccumulator();
  let scaffold: AssistantMessage | undefined;

  const flush = (): void => {
    if (isEmpty(accumulator)) return;

    const candidate = freezeMessage<FoldedMessage>({
      content: [{ text: renderFold(accumulator), type: 'text' }],
      createdAt: new Date(),
      foldedMessageIds: accumulator.messages.map((message) => message.messageId),
      messageId: nanoid(),
      role: 'folded',
    });

    if (isWorthFolding(candidate, accumulator.messages, estimateTokens, minReductionRatio)) {
      events.push(candidate);
    }
    accumulator = createAccumulator();
  };

  const commitScaffold = (): void => {
    if (scaffold === undefined) return;
    accumulator.messages.push(scaffold);
    scaffold = undefined;
  };

  for (const message of history.slice(from, to + 1)) {
    if (message.role === 'toolCall') {
      commitScaffold();
      trackedPush(accumulator.calls, message.trackId, message);
      accumulator.messages.push(message);
      continue;
    }

    if (message.role === 'toolResponse') {
      if (message.execution !== 'deferredResult') {
        commitScaffold();
        trackedPush(accumulator.responses, message.trackId, message);
        accumulator.messages.push(message);
        continue;
      }
    }

    // Reasoning remains active byte-for-byte, but it is transparent to a fold:
    // scratchpad emitted between tool iterations must not fragment one loop into
    // a placeholder per call.
    if (message.role === 'reasoning') continue;

    // Provider streams materialize a textless assistant turn to carry tool
    // calls. It said nothing, so it is scaffolding rather than speech: held
    // until tool traffic claims it, and then folded away with the very calls it
    // was there to carry. Left behind instead, it is a turn with neither content
    // nor tool calls — which is not a message any provider will accept.
    if (message.role === 'assistant' && message.content.length === 0) {
      scaffold = message;
      continue;
    }

    flush();
    // A scaffold no tool traffic ever claimed is left where it is.
    scaffold = undefined;
  }

  flush();

  let folded: Message[] = [...history];
  for (const event of events) {
    folded = applyFold(folded, event);
  }

  return { events, history: folded };
}

export { applyFold, foldHistory };

export type { FoldOptions, FoldResult };
