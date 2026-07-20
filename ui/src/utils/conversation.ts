/*
 * Turns the flat message log into the shape the transcript renders.
 *
 * The gateway stores messages in arrival order: user prose, reasoning, tool
 * calls, tool responses, assistant prose. The UI groups them into turns — one
 * user message, then everything the agent did in response as a single block —
 * and pairs each tool call with its responses.
 *
 * All of it is pure, so the grouping rules can be tested without a browser.
 */

import type { Message, ToolCallMessage, ToolResponseMessage } from './types';

/** A message with the wall-clock time it was recorded, when known. */
type TimedMessage = { message: Message; time: Date | null };

type ConversationItem =
  | { kind: 'user'; entry: TimedMessage }
  | { kind: 'agent'; entries: TimedMessage[]; live: boolean };

/** A tool call and every response that came back on the same track. */
type ToolAction = {
  name: string;
  trackId: string;
  call?: ToolCallMessage;
  responses: ToolResponseMessage[];
  time: Date | null;
};

type AgentBlock =
  | { kind: 'reasoning'; entry: TimedMessage }
  | { kind: 'assistant'; entry: TimedMessage }
  /** A run of tool activity with no prose between the calls. */
  | { kind: 'tools'; actions: ToolAction[] };

/**
 * Splits the log into alternating user and agent turns.
 *
 * Anything that is not a user message belongs to the agent turn in progress,
 * so consecutive agent output collapses into one block. `hasLiveContent` marks
 * the trailing turn as still streaming — appending an empty agent block when
 * the run starts before any message has settled.
 */
function buildConversation(
  messages: Message[],
  times: Array<Date | null>,
  hasLiveContent: boolean,
): ConversationItem[] {
  const items: ConversationItem[] = [];
  for (const [index, message] of messages.entries()) {
    const entry = { message, time: times[index] ?? null };
    if (message.role === 'user') {
      items.push({ entry, kind: 'user' });
      continue;
    }
    const previous = items.at(-1);
    if (previous?.kind === 'agent') previous.entries.push(entry);
    else items.push({ entries: [entry], kind: 'agent', live: false });
  }

  if (hasLiveContent) {
    const previous = items.at(-1);
    if (previous?.kind === 'agent') previous.live = true;
    else items.push({ entries: [], kind: 'agent', live: true });
  }
  return items;
}

/**
 * Expands one agent turn into renderable blocks.
 *
 * Two groupings happen here. Tool calls and their responses arrive as separate
 * messages, potentially far apart, and are merged by `trackId` into a single
 * action. Then tools the agent invoked back-to-back — with no reasoning or
 * prose between them — collapse into one block, so a parallel batch reads as
 * one step rather than N identical cards.
 *
 * A response always folds into the action its call created, wherever that
 * ended up, so a late result never re-opens a closed block.
 */
function buildAgentBlocks(entries: TimedMessage[]): AgentBlock[] {
  const blocks: AgentBlock[] = [];
  const byTrackId = new Map<string, ToolAction>();

  for (const entry of entries) {
    const message = entry.message;
    if (message.role === 'reasoning' || message.role === 'assistant') {
      blocks.push({ entry, kind: message.role });
      continue;
    }
    if (message.role !== 'toolCall' && message.role !== 'toolResponse') continue;

    let action = byTrackId.get(message.trackId);
    if (!action) {
      action = { name: message.name, responses: [], time: entry.time, trackId: message.trackId };
      byTrackId.set(message.trackId, action);

      const last = blocks.at(-1);
      if (last?.kind === 'tools') last.actions.push(action);
      else blocks.push({ actions: [action], kind: 'tools' });
    }
    if (message.role === 'toolCall') action.call = message;
    else action.responses.push(message);
    // The action carries the time of its most recent message.
    action.time = entry.time ?? action.time;
  }
  return blocks;
}

/** Status word shown next to a tool action in the transcript. */
function actionState(action: ToolAction): string {
  const response = action.responses.at(-1);
  if (!response) return 'Running';
  if (response.isError) return 'Failed';
  if (response.execution === 'deferredAck') return 'Accepted';
  return 'Completed';
}

/**
 * Timestamp for an agent turn: when it finished answering, falling back to its
 * last activity and finally to when the run began.
 */
function agentTime(entries: TimedMessage[], fallback: Date | null): Date | null {
  return entries.findLast((entry) => entry.message.role === 'assistant')?.time
    ?? entries.at(-1)?.time
    ?? fallback;
}

export {
  actionState,
  agentTime,
  buildAgentBlocks,
  buildConversation,
};

export type {
  AgentBlock,
  ConversationItem,
  TimedMessage,
  ToolAction,
};
