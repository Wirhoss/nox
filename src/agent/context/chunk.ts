import { contentToString } from '@nox/extension-api';

import { messageIdentityToString, trackedHeaderToString } from './message';

import type { Message } from '@nox/extension-api';

const DEFAULT_CHUNK_SIZE = 1000;

/**
 * Whether a message belongs in the searchable index at all.
 *
 * The three excluded roles are derived text: a fold or a compaction is a
 * summary of messages that are themselves indexed, and reasoning is not
 * something the model should be able to quote back to itself as fact. A tool
 * response still waiting on a deferral or an approval has no result yet, and an
 * empty content message has nothing to match.
 */
function isIndexable(message: Message): boolean {
  switch (message.role) {
    case 'compacted':
    case 'folded':
    case 'reasoning':
      return false;
    case 'toolResponse':
      return message.execution !== 'deferredAck' && message.execution !== 'permissionPending';
    case 'assistant':
    case 'user':
      return message.content.some((part) => part.type !== 'text' || part.text.length > 0);
    case 'toolCall':
      return true;
  }
}

function chunkString(text: string, chunkSize: number): string[] {
  if (text.length === 0) return [''];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);
    if (end < text.length) {
      const newline = text.indexOf('\n', end);
      if (newline !== -1 && newline - end <= chunkSize / 4) end = newline + 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function renderChunks(
  text: string,
  chunkSize: number,
  render: (chunk: string, position: string) => string,
): string[] {
  const chunks = chunkString(text, chunkSize);
  return chunks.map((chunk, index) =>
    render(chunk, `${String(index + 1)} of ${String(chunks.length)}`),
  );
}

/**
 * One message rendered as the units a search actually returns.
 *
 * The unit is a chunk rather than a message because a single tool response can
 * be megabytes: indexing it whole would make one hit blow the entire response
 * budget, and would rank a huge document by terms scattered across parts of it
 * the model never asked about. Every chunk repeats the message's header so a
 * hit read on its own still says who wrote it, when, and under which track ID —
 * the identifiers the reader needs to go fetch the rest.
 */
function chunkMessage(message: Message, chunkSize: number = DEFAULT_CHUNK_SIZE): string[] {
  if (!isIndexable(message)) return [];

  if (message.role === 'toolCall') {
    return renderChunks(
      JSON.stringify(message.arguments),
      chunkSize,
      (chunk, position) =>
        trackedHeaderToString(message) +
        `\n${messageIdentityToString(message)}` +
        `\nArguments chunk ${position}` +
        `\nArguments:\n${chunk}`,
    );
  }

  if (message.role === 'toolResponse') {
    return renderChunks(
      contentToString(message.response),
      chunkSize,
      (chunk, position) =>
        trackedHeaderToString(message) +
        `\nExecution: ${message.execution}\nIs Error: ${String(message.isError ?? false)}` +
        `\n${messageIdentityToString(message)}` +
        `\nResponse chunk ${position}` +
        `\nResponse:\n${chunk}`,
    );
  }

  return renderChunks(
    contentToString(message.content),
    chunkSize,
    (chunk, position) =>
      `Role: ${message.role}` +
      `\n${messageIdentityToString(message)}` +
      `\nContent chunk ${position}` +
      `\nContent:\n${chunk}`,
  );
}

export { chunkMessage, DEFAULT_CHUNK_SIZE, isIndexable };
