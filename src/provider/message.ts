interface MessageBase {
  readonly createdAt: Date;
  readonly messageId: string;
}

interface MessageContentText {
  type: 'text';
  text: string;
}

interface MessageContentImage {
  type: 'image';
  source:
    | { type: 'base64'; mediaType: string; data: string }
    | { type: 'url'; url: string };
}

type MessageContent = MessageContentText | MessageContentImage;

interface AssistantMessage extends MessageBase {
  role: 'assistant';
  content: MessageContent[];
}

interface CompactedMessage extends MessageBase {
  role: 'compacted';
  content: MessageContent[];
  compactedMessageIds: readonly string[];
}

interface FoldedMessage extends MessageBase {
  role: 'folded';
  anchorMessageId: string;
  foldedMessageIds: readonly string[];
  content: MessageContent[];
}

interface ReasoningMessage extends MessageBase {
  role: 'reasoning';
  content: MessageContent[];
}

interface UserMessage extends MessageBase {
  role: 'user';
  content: MessageContent[];
}

interface ToolCallMessage extends MessageBase {
  role: 'toolCall';
  name: string;
  trackId: string;
  arguments: Record<string, unknown>;
}

type ToolResponseExecution = 'immediate' | 'deferredAck' | 'deferredResult';

interface ToolResponseMessage extends MessageBase {
  role: 'toolResponse';
  name: string;
  trackId: string;
  execution: ToolResponseExecution;
  response: MessageContent[];
  isError?: boolean;
}

function contentToString(content: MessageContent[]): string {
  return content.map((c) => {
    if (c.type === 'text') return c.text;
    if (c.type === 'image') {
      if (c.source.type === 'base64') return `[Image: ${c.source.mediaType}]`;
      if (c.source.type === 'url') return `[Image: ${c.source.url}]`;
    }
    return '';
  }).join('\n');
}

function assistantMessageToString(message: AssistantMessage): string {
  return `Role: ${message.role}\nContent:\n${contentToString(message.content)}`
  + `\nCreated At: ${message.createdAt.toISOString()}\nMessage ID: ${message.messageId}`;
}

function reasoningMessageToString(message: ReasoningMessage): string {
  return `Role: ${message.role}\nContent:\n${contentToString(message.content)}`
  + `\nCreated At: ${message.createdAt.toISOString()}\nMessage ID: ${message.messageId}`;
}

function userMessageToString(message: UserMessage): string {
  return `Role: ${message.role}\nContent:\n${contentToString(message.content)}`
  + `\nCreated At: ${message.createdAt.toISOString()}\nMessage ID: ${message.messageId}`;
}

function compactedMessageToString(message: CompactedMessage): string {
  return `Role: ${message.role}\nContent:\n${contentToString(message.content)}`
  + `\nCreated At: ${message.createdAt.toISOString()}\nMessage ID: ${message.messageId}`
  + `\nCompacted Message IDs: ${message.compactedMessageIds.join(', ')}`;
}

function foldedMessageToString(message: FoldedMessage): string {
  return `Role: ${message.role}\nAnchor Message ID: ${message.anchorMessageId}`
  + `\nFolded Message IDs: ${message.foldedMessageIds.join(', ')}`
  + `\nContent:\n${contentToString(message.content)}`
  + `\nCreated At: ${message.createdAt.toISOString()}\nMessage ID: ${message.messageId}`;
}

function toolCallMessageToString(message: ToolCallMessage): string {
  return `Role: ${message.role}\nName: ${message.name}\nTrack ID: ${message.trackId}`
  + `\nArguments: ${JSON.stringify(message.arguments)}`
  + `\nCreated At: ${message.createdAt.toISOString()}\nMessage ID: ${message.messageId}`;
}

function toolResponseMessageToString(message: ToolResponseMessage): string {
  return `Role: ${message.role}\nName: ${message.name}\nTrack ID: ${message.trackId}`
  + `\nExecution: ${message.execution}\nIs Error: ${message.isError ?? false}`
  + `\nCreated At: ${message.createdAt.toISOString()}\nMessage ID: ${message.messageId}`
  + `\nResponse:\n${contentToString(message.response)}`;
}

function messageToString(message: Message): string {
  if (message.role === 'assistant') return assistantMessageToString(message);
  if (message.role === 'reasoning') return reasoningMessageToString(message);
  if (message.role === 'user') return userMessageToString(message);
  if (message.role === 'compacted') return compactedMessageToString(message);
  if (message.role === 'folded') return foldedMessageToString(message);
  if (message.role === 'toolCall') return toolCallMessageToString(message);
  if (message.role === 'toolResponse') return toolResponseMessageToString(message);
  return 'Unknown message role';
}

type Message = AssistantMessage
  | CompactedMessage
  | FoldedMessage
  | ReasoningMessage
  | ToolCallMessage
  | ToolResponseMessage
  | UserMessage;

export {
  contentToString,
  messageToString,
};

export type {
  AssistantMessage,
  CompactedMessage,
  FoldedMessage,
  Message,
  MessageContent,
  MessageContentImage,
  MessageContentText,
  ReasoningMessage,
  ToolCallMessage,
  ToolResponseExecution,
  ToolResponseMessage,
  UserMessage,
};
