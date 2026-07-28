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

interface CompactionMessage extends MessageBase {
  role: 'compaction';
  content: MessageContent[];
  replacedMessageIds: readonly string[];
}

interface FoldMessage extends MessageBase {
  role: 'fold';
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

type Message = AssistantMessage
  | CompactionMessage
  | FoldMessage
  | ReasoningMessage
  | ToolCallMessage
  | ToolResponseMessage
  | UserMessage;

export type {
  AssistantMessage,
  CompactionMessage,
  FoldMessage,
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
