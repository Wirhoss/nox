import {
  type ContentMessage,
  contentToString,
  type Message,
  principalToString,
  type ToolCallMessage,
  type ToolResponseMessage,
} from '@nox/extension-api';

const MESSAGE_ROLES = [
  'assistant',
  'compacted',
  'folded',
  'reasoning',
  'toolCall',
  'toolResponse',
  'user',
] as const satisfies readonly Message['role'][];

type MessageRole = (typeof MESSAGE_ROLES)[number];
type AssertNever<T extends never> = T;
type _EveryRoleIsListed = AssertNever<Exclude<Message['role'], MessageRole>>;

function messageIdentityToString(message: Message): string {
  return `Created At: ${message.createdAt.toISOString()}\nMessage ID: ${message.messageId}`;
}

function trackedHeaderToString(message: ToolCallMessage | ToolResponseMessage): string {
  return `Role: ${message.role}\nName: ${message.name}\nTrack ID: ${message.trackId}`;
}

function contentMessageToString(message: ContentMessage): string {
  return (
    `Role: ${message.role}\nContent:\n${contentToString(message.content)}` +
    `\n${messageIdentityToString(message)}`
  );
}

function messageToString(message: Message): string {
  switch (message.role) {
    case 'assistant':
    case 'reasoning':
      return contentMessageToString(message);
    case 'user':
      return (
        `Role: user\nFrom: ${principalToString(message.origin.principal)}` +
        `\nContent:\n${contentToString(message.content)}` +
        `\n${messageIdentityToString(message)}`
      );
    case 'compacted':
      return (
        contentMessageToString(message) +
        `\nCompacted Message IDs: ${message.compactedMessageIds.join(', ')}`
      );
    case 'folded':
      return (
        `Role: ${message.role}\nAnchor Message ID: ${message.anchorMessageId}` +
        `\nFolded Message IDs: ${message.foldedMessageIds.join(', ')}` +
        `\nContent:\n${contentToString(message.content)}` +
        `\n${messageIdentityToString(message)}`
      );
    case 'toolCall':
      return (
        trackedHeaderToString(message) +
        `\nArguments: ${JSON.stringify(message.arguments)}` +
        `\n${messageIdentityToString(message)}`
      );
    case 'toolResponse':
      return (
        trackedHeaderToString(message) +
        `\nExecution: ${message.execution}\nIs Error: ${String(message.isError ?? false)}` +
        `\n${messageIdentityToString(message)}` +
        `\nResponse:\n${contentToString(message.response)}`
      );
  }
}

export { MESSAGE_ROLES, messageIdentityToString, messageToString, trackedHeaderToString };

export type { MessageRole };
