interface MessageContentText {
  type: 'text';
  text: string;
}

interface MessageContentImage {
  type: 'image';
  source:
    | { kind: 'base64'; mediaType: string; data: string }
    | { kind: 'url'; url: string };
}

type MessageContent = MessageContentText | MessageContentImage;

interface AssistantMessage {
  role: 'assistant';
  content: MessageContent[];
}

interface ReasoningMessage {
  role: 'reasoning';
  content: MessageContent[];
}

interface ToolCallMessage {
  role: 'toolCall';
  name: string;
  trackId: string;
  arguments: Record<string, unknown>;
}

type ToolResponseExecution = 'immediate' | 'deferredAck' | 'deferredResult';

interface ToolResponseMessage {
  role: 'toolResponse';
  name: string;
  trackId: string;
  execution: ToolResponseExecution;
  response: MessageContent[];
  isError?: boolean;
}

interface UserMessage {
  role: 'user';
  content: MessageContent[];
}

type Message = AssistantMessage | ReasoningMessage | UserMessage | ToolCallMessage | ToolResponseMessage;

function toUserMessage(text: string): UserMessage {
  return {
    role: 'user',
    content: [{
      type: 'text',
      text,
    }],
  };
}

export type {
  AssistantMessage,
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

export { toUserMessage };
