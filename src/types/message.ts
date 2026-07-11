interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}

interface MessageContentText {
  type: "text";
  text: string;
}

interface MessageContentImage {
  type: "image";
  source:
    | { kind: "base64"; mediaType: string; data: string }
    | { kind: "url"; url: string };
}

interface MessageContentToolCall {
  type: "tool_call";
  name: string;
  trackId: string;
  arguments: Record<string, unknown>;
}

type ToolResponse = (MessageContentText | MessageContentImage)[];

interface MessageContentToolResponse {
  type: "tool_response";
  name: string;
  trackId: string;
  response: ToolResponse;
  isError?: boolean;
}

type MessageContent = MessageContentText | MessageContentImage | MessageContentToolCall | MessageContentToolResponse;

interface Message {
  role: "user" | "assistant";
  content: MessageContent[];
}

type MessageContentStreamEvent = 
  | { type: "end"; content: MessageContent[]; aborted?: boolean; usage?: Usage }
  | { type: "error"; error: Error }
  | { type: "text"; text: string }
  | { type: "toolCall"; toolCall: MessageContentToolCall };


export type {
  Message,
  MessageContent,
  MessageContentImage,
  MessageContentStreamEvent,
  MessageContentText,
  MessageContentToolCall,
  MessageContentToolResponse,
  ToolResponse,
  Usage
};