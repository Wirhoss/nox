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

interface ToolCallMessage {
  role: 'toolCall';
  name: string;
  trackId: string;
  arguments: Record<string, unknown>;
}

interface ToolResponseMessage {
  role: 'toolResponse';
  name: string;
  trackId: string;
  response: MessageContent[];
  isError?: boolean;
}

interface UserMessage {
  role: 'user';
  content: MessageContent[];
}

type Message = AssistantMessage | UserMessage | ToolCallMessage | ToolResponseMessage;

export type {
  AssistantMessage,
  Message,
  MessageContent,
  MessageContentImage,
  MessageContentText,
  ToolCallMessage,
  ToolResponseMessage,
  UserMessage,
};