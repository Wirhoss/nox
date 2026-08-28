import {
  type ContentMessage,
  contentToString,
  type Message,
  type MessageOrigin,
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

/**
 * Who said it, as the model should read it.
 *
 * The principal is always there and is always what anything was decided from. A
 * display name goes in front when the transport had one, because a shared
 * transcript where everyone is an opaque ID is one the model cannot talk about:
 * it cannot address anyone, or notice that two messages came from the same
 * person, without comparing digits.
 *
 * The name never replaces the principal. Names are chosen, repeat, and change,
 * so a transcript carrying only names is one where two people can be made to
 * look like one.
 */
function originToString(origin: MessageOrigin): string {
  const subject = principalToString(origin.principal);
  return origin.displayName === undefined ? subject : `${origin.displayName} <${subject}>`;
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

export {
  MESSAGE_ROLES,
  messageIdentityToString,
  messageToString,
  originToString,
  trackedHeaderToString,
};

export type { MessageRole };
