import { nanoid } from "nanoid";
import type { AssistantMessage, FoldedMessage, Message, ToolCallMessage, ToolResponseMessage } from "../../provider";

interface FoldResult {
  history: Message[];
  events: FoldedMessage[];
}

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

function renderFold(toolCallMessages: ReadonlyMap<string, ToolCallMessage>, toolResponseMessages: ReadonlyMap<string, ToolResponseMessage>): string {
  let toolFoldedMessage = '-----The following tool calls and responses have been folded-----';
  for (const toolCallMessage of toolCallMessages.values()) {
    const response = toolResponseMessages.get(toolCallMessage.trackId);
    toolFoldedMessage += `\nTool Name: ${toolCallMessage.name}`
      + `\nTrack Id: ${toolCallMessage.trackId}`
      + `\nArguments: ${JSON.stringify(toolCallMessage.arguments)}`
      + `\nWas Error: ${response?.isError ?? 'unknown'}`
      + `\nWas Deferred: ${response?.execution === 'deferredAck'}`
      + `\nResponse Size: ${response?.response ? Buffer.byteLength(JSON.stringify(response?.response)) + ' bytes' : 'n/a'}`
      + '\n- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -';
  }
  return toolFoldedMessage;
}

function resolveIndex(history: readonly Message[], messageId: string | undefined, fallback: number): number {
  if (messageId === undefined) return fallback;
  const index = history.findIndex((message) => message.messageId === messageId);
  if (index === -1) {
    throw new Error(`Fold range references a missing message ${messageId}.`);
  }
  return index;
}

function foldHistory(history: readonly Message[], fromMessageId?: string, toMessageId?: string): FoldResult {
  const from = resolveIndex(history, fromMessageId, 0);
  const to = resolveIndex(history, toMessageId, history.length - 1);
  if (to < from) {
    throw new Error('Fold range ends before it starts.');
  }

  const events: FoldedMessage[] = [];

  const toolCallMessages: Map<string, ToolCallMessage> = new Map();
  const toolResponseMessages: Map<string, ToolResponseMessage> = new Map();
  let foldedMessageIds: string[] = [];
  let anchor: AssistantMessage | undefined = history
    .slice(0, from)
    .findLast((message): message is AssistantMessage => message.role === 'assistant');

  for (const message of history.slice(from, to + 1)) {
    if (message.role === 'toolCall') {
      toolCallMessages.set(message.trackId, message);
      foldedMessageIds.push(message.messageId);
      continue;
    }

    if (message.role === 'toolResponse') {
      if (message.execution === 'deferredResult') continue;
      toolResponseMessages.set(message.trackId, message);
      foldedMessageIds.push(message.messageId);
      continue;
    }

    if (message.role !== 'assistant') continue;

    if (toolCallMessages.size > 0) {
      if (anchor === undefined) {
        throw new Error('No anchor assistant message found for folding tool calls and responses.');
      }
      events.push(Object.freeze<FoldedMessage>({
        role: 'folded',
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
    if (anchor === undefined) {
      throw new Error('No anchor assistant message found for folding tool calls and responses.');
    }
    events.push(Object.freeze<FoldedMessage>({
      role: 'folded',
      anchorMessageId: anchor.messageId,
      content: [{ type: 'text', text: renderFold(toolCallMessages, toolResponseMessages) }],
      createdAt: new Date(),
      foldedMessageIds: Object.freeze(foldedMessageIds),
      messageId: nanoid(),
    }));
    toolCallMessages.clear();
    toolResponseMessages.clear();
  }

  let folded: Message[] = [...history];
  for (const event of events) {
    folded = applyFold(folded, event);
  }

  return { events, history: folded };
}

export {
  foldHistory,
  applyFold
}