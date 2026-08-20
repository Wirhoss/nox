interface MessageBase {
  readonly createdAt: Date;
  readonly messageId: string;
}

interface MessageContentText {
  readonly type: 'text';
  readonly text: string;
}

interface MessageContentImage {
  readonly type: 'image';
  readonly source:
    | { readonly type: 'base64'; readonly mediaType: string; readonly data: string }
    | { readonly type: 'url'; readonly url: string };
}

type MessageContent = MessageContentImage | MessageContentText;

interface AssistantMessage extends MessageBase {
  readonly role: 'assistant';
  readonly content: readonly MessageContent[];
}

interface CompactedMessage extends MessageBase {
  readonly role: 'compacted';
  readonly content: readonly MessageContent[];
  readonly compactedMessageIds: readonly string[];
}

interface FoldedMessage extends MessageBase {
  readonly role: 'folded';
  readonly anchorMessageId: string;
  readonly foldedMessageIds: readonly string[];
  readonly content: readonly MessageContent[];
}

interface ReasoningMessage extends MessageBase {
  readonly role: 'reasoning';
  readonly content: readonly MessageContent[];
}

interface UserMessage extends MessageBase {
  readonly role: 'user';
  readonly content: readonly MessageContent[];
}

interface ToolCallMessage extends MessageBase {
  readonly role: 'toolCall';
  readonly name: string;
  readonly trackId: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

const TOOL_RESPONSE_EXECUTIONS = ['deferredAck', 'deferredResult', 'immediate'] as const;

type ToolResponseExecution = (typeof TOOL_RESPONSE_EXECUTIONS)[number];

interface ToolResponseMessage extends MessageBase {
  readonly role: 'toolResponse';
  readonly name: string;
  readonly trackId: string;
  readonly execution: ToolResponseExecution;
  readonly response: readonly MessageContent[];
  readonly isError?: boolean;
}

/**
 * The single list of roles: storage enums and any other consumer derive from
 * this rather than restating the union.
 */
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

/**
 * Fails to compile if a Message variant's role is missing from MESSAGE_ROLES;
 * `satisfies` alone only proves the listed roles are valid, not that they are
 * all of them.
 */
type _EveryRoleIsListed = AssertNever<Exclude<Message['role'], MessageRole>>;

function contentToString(content: readonly MessageContent[]): string {
  return content
    .map((item) => {
      switch (item.type) {
        case 'text':
          return item.text;
        case 'image':
          return item.source.type === 'base64'
            ? `[Image: ${item.source.mediaType}]`
            : `[Image: ${item.source.url}]`;
      }
    })
    .join('\n');
}

/** The trailing fields every rendered message ends with. */
function messageIdentityToString(message: Message): string {
  return `Created At: ${message.createdAt.toISOString()}\nMessage ID: ${message.messageId}`;
}

/** The leading fields shared by the two tool-tracked message roles. */
function trackedHeaderToString(message: ToolCallMessage | ToolResponseMessage): string {
  return `Role: ${message.role}\nName: ${message.name}\nTrack ID: ${message.trackId}`;
}

/** Renders the roles whose whole payload is content, in their shared shape. */
function contentMessageToString(message: ContentMessage): string {
  return (
    `Role: ${message.role}\nContent:\n${contentToString(message.content)}` +
    `\n${messageIdentityToString(message)}`
  );
}

function compactedMessageToString(message: CompactedMessage): string {
  return (
    contentMessageToString(message) +
    `\nCompacted Message IDs: ${message.compactedMessageIds.join(', ')}`
  );
}

function foldedMessageToString(message: FoldedMessage): string {
  return (
    `Role: ${message.role}\nAnchor Message ID: ${message.anchorMessageId}` +
    `\nFolded Message IDs: ${message.foldedMessageIds.join(', ')}` +
    `\nContent:\n${contentToString(message.content)}` +
    `\n${messageIdentityToString(message)}`
  );
}

function toolCallMessageToString(message: ToolCallMessage): string {
  return (
    trackedHeaderToString(message) +
    `\nArguments: ${JSON.stringify(message.arguments)}` +
    `\n${messageIdentityToString(message)}`
  );
}

function toolResponseMessageToString(message: ToolResponseMessage): string {
  return (
    trackedHeaderToString(message) +
    `\nExecution: ${message.execution}\nIs Error: ${String(message.isError ?? false)}` +
    `\n${messageIdentityToString(message)}` +
    `\nResponse:\n${contentToString(message.response)}`
  );
}

function messageToString(message: Message): string {
  switch (message.role) {
    case 'assistant':
    case 'reasoning':
    case 'user':
      return contentMessageToString(message);
    case 'compacted':
      return compactedMessageToString(message);
    case 'folded':
      return foldedMessageToString(message);
    case 'toolCall':
      return toolCallMessageToString(message);
    case 'toolResponse':
      return toolResponseMessageToString(message);
  }
}

type Message =
  | AssistantMessage
  | CompactedMessage
  | FoldedMessage
  | ReasoningMessage
  | ToolCallMessage
  | ToolResponseMessage
  | UserMessage;

/** The roles whose payload is content, rendered through one shared shape. */
type ContentMessage =
  AssistantMessage | CompactedMessage | FoldedMessage | ReasoningMessage | UserMessage;

export {
  contentToString,
  MESSAGE_ROLES,
  messageIdentityToString,
  messageToString,
  TOOL_RESPONSE_EXECUTIONS,
  trackedHeaderToString,
};

export type {
  AssistantMessage,
  CompactedMessage,
  ContentMessage,
  FoldedMessage,
  Message,
  MessageContent,
  MessageContentImage,
  MessageContentText,
  MessageRole,
  ReasoningMessage,
  ToolCallMessage,
  ToolResponseExecution,
  ToolResponseMessage,
  UserMessage,
};
