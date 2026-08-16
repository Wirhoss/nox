interface MessageBase {
  readonly createdAt: Date;
  readonly messageId: string;
}

interface MessageContentText {
  readonly type: "text";
  readonly text: string;
}

interface MessageContentImage {
  readonly type: "image";
  readonly source:
    | { readonly type: "base64"; readonly mediaType: string; readonly data: string }
    | { readonly type: "url"; readonly url: string };
}

type MessageContent = MessageContentImage | MessageContentText;

interface AssistantMessage extends MessageBase {
  readonly role: "assistant";
  readonly content: readonly MessageContent[];
}

interface CompactedMessage extends MessageBase {
  readonly role: "compacted";
  readonly content: readonly MessageContent[];
  readonly compactedMessageIds: readonly string[];
}

interface FoldedMessage extends MessageBase {
  readonly role: "folded";
  readonly anchorMessageId: string;
  readonly foldedMessageIds: readonly string[];
  readonly content: readonly MessageContent[];
}

interface ReasoningMessage extends MessageBase {
  readonly role: "reasoning";
  readonly content: readonly MessageContent[];
}

interface UserMessage extends MessageBase {
  readonly role: "user";
  readonly content: readonly MessageContent[];
}

interface ToolCallMessage extends MessageBase {
  readonly role: "toolCall";
  readonly name: string;
  readonly trackId: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

type ToolResponseExecution = "deferredAck" | "deferredResult" | "immediate";

interface ToolResponseMessage extends MessageBase {
  readonly role: "toolResponse";
  readonly name: string;
  readonly trackId: string;
  readonly execution: ToolResponseExecution;
  readonly response: readonly MessageContent[];
  readonly isError?: boolean;
}

function contentToString(content: readonly MessageContent[]): string {
  return content
    .map((item) => {
      switch (item.type) {
        case "text":
          return item.text;
        case "image":
          return item.source.type === "base64"
            ? `[Image: ${item.source.mediaType}]`
            : `[Image: ${item.source.url}]`;
      }
    })
    .join("\n");
}

function assistantMessageToString(message: AssistantMessage): string {
  return (
    `Role: ${message.role}\nContent:\n${contentToString(message.content)}` +
    `\nCreated At: ${message.createdAt.toISOString()}\nMessage ID: ${message.messageId}`
  );
}

function reasoningMessageToString(message: ReasoningMessage): string {
  return (
    `Role: ${message.role}\nContent:\n${contentToString(message.content)}` +
    `\nCreated At: ${message.createdAt.toISOString()}\nMessage ID: ${message.messageId}`
  );
}

function userMessageToString(message: UserMessage): string {
  return (
    `Role: ${message.role}\nContent:\n${contentToString(message.content)}` +
    `\nCreated At: ${message.createdAt.toISOString()}\nMessage ID: ${message.messageId}`
  );
}

function compactedMessageToString(message: CompactedMessage): string {
  return (
    `Role: ${message.role}\nContent:\n${contentToString(message.content)}` +
    `\nCreated At: ${message.createdAt.toISOString()}\nMessage ID: ${message.messageId}` +
    `\nCompacted Message IDs: ${message.compactedMessageIds.join(", ")}`
  );
}

function foldedMessageToString(message: FoldedMessage): string {
  return (
    `Role: ${message.role}\nAnchor Message ID: ${message.anchorMessageId}` +
    `\nFolded Message IDs: ${message.foldedMessageIds.join(", ")}` +
    `\nContent:\n${contentToString(message.content)}` +
    `\nCreated At: ${message.createdAt.toISOString()}\nMessage ID: ${message.messageId}`
  );
}

function toolCallMessageToString(message: ToolCallMessage): string {
  return (
    `Role: ${message.role}\nName: ${message.name}\nTrack ID: ${message.trackId}` +
    `\nArguments: ${JSON.stringify(message.arguments)}` +
    `\nCreated At: ${message.createdAt.toISOString()}\nMessage ID: ${message.messageId}`
  );
}

function toolResponseMessageToString(message: ToolResponseMessage): string {
  return (
    `Role: ${message.role}\nName: ${message.name}\nTrack ID: ${message.trackId}` +
    `\nExecution: ${message.execution}\nIs Error: ${String(message.isError ?? false)}` +
    `\nCreated At: ${message.createdAt.toISOString()}\nMessage ID: ${message.messageId}` +
    `\nResponse:\n${contentToString(message.response)}`
  );
}

function messageToString(message: Message): string {
  switch (message.role) {
    case "assistant":
      return assistantMessageToString(message);
    case "compacted":
      return compactedMessageToString(message);
    case "folded":
      return foldedMessageToString(message);
    case "reasoning":
      return reasoningMessageToString(message);
    case "toolCall":
      return toolCallMessageToString(message);
    case "toolResponse":
      return toolResponseMessageToString(message);
    case "user":
      return userMessageToString(message);
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

export { contentToString, messageToString };

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
