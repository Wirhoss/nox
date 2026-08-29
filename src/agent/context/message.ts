import {
  type ContentMessage,
  contentToString,
  type Message,
  originToString,
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

/**
 * The artifacts a message actually carries.
 *
 * A tool call is skipped on purpose: its arguments are the model's own words,
 * so an ID written there is a claim, not a receipt. Only what came back — a
 * tool response, or content some other participant contributed — is evidence
 * that this conversation was ever handed the artifact.
 */
function artifactIdsIn(message: Message): string[] {
  if (message.role === 'toolCall') return [];

  const content = message.role === 'toolResponse' ? message.response : message.content;
  const ids: string[] = [];
  for (const part of content) {
    if (part.type === 'artifact') ids.push(part.artifact.artifactId);
  }
  return ids;
}

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
        `Role: user\nFrom: ${originToString(message.origin)}` +
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
        `Role: ${message.role}\nFolded Message IDs: ${message.foldedMessageIds.join(', ')}` +
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

export {
  artifactIdsIn,
  MESSAGE_ROLES,
  messageIdentityToString,
  messageToString,
  originToString,
  trackedHeaderToString,
};

export type { MessageRole };
