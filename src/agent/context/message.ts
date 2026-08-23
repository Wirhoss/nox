import { type MessageOrigin, principalToString } from '../../auth/principal';
import {
  type ContentArtifact,
  type ContentAudio,
  type ContentDocument,
  type ContentImage,
  type ContentPart,
  type ContentText,
  contentToString,
  type ContentVideo,
} from '../../content/content';

interface MessageBase {
  readonly createdAt: Date;
  readonly messageId: string;
}

type MessageContent = ContentPart;
type MessageContentArtifact = ContentArtifact;
type MessageContentText = ContentText;
type MessageContentImage = ContentImage;
type MessageContentAudio = ContentAudio;
type MessageContentVideo = ContentVideo;
type MessageContentDocument = ContentDocument;

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

/**
 * Something a principal said. `origin` is not optional: in a shared conversation
 * an unattributed message is one nobody can be held to, and the model is shown
 * who spoke so it can tell one participant from another.
 *
 * This is provenance only. Authority for an execution is fixed when its run
 * starts and is never recomputed from messages sitting in the transcript.
 */
interface UserMessage extends MessageBase {
  readonly role: 'user';
  readonly content: readonly MessageContent[];
  readonly origin: MessageOrigin;
}

interface ToolCallMessage extends MessageBase {
  readonly role: 'toolCall';
  readonly name: string;
  readonly trackId: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

const TOOL_RESPONSE_EXECUTIONS = [
  'deferredAck',
  'deferredResult',
  'immediate',
  'permissionPending',
] as const;

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

/**
 * What a provider should send for a user message.
 *
 * A shared conversation is not one voice, and a model handed every participant
 * under the same `user` role cannot tell who asked for what — which is exactly
 * the distinction the rest of this design depends on. Every provider maps the
 * wire format its own way; who spoke is not a wire detail, so it is decided
 * here and once.
 *
 * The author rides in the content rather than in a provider-specific author
 * field: those exist, but they restrict the characters allowed and are ignored
 * by several OpenAI-compatible gateways, which would silently drop the
 * attribution on exactly the deployments most likely to be multiuser.
 */
function userContentForModel(message: UserMessage): readonly MessageContent[] {
  return [
    { text: `[from ${principalToString(message.origin.principal)}]\n`, type: 'text' },
    ...message.content,
  ];
}

/** The author is shown to the model; a shared channel is not one voice. */
function userMessageToString(message: UserMessage): string {
  return (
    `Role: user\nFrom: ${principalToString(message.origin.principal)}` +
    `\nContent:\n${contentToString(message.content)}` +
    `\n${messageIdentityToString(message)}`
  );
}

function messageToString(message: Message): string {
  switch (message.role) {
    case 'assistant':
    case 'reasoning':
      return contentMessageToString(message);
    case 'user':
      return userMessageToString(message);
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
  userContentForModel,
};

export type {
  AssistantMessage,
  CompactedMessage,
  ContentMessage,
  FoldedMessage,
  Message,
  MessageContent,
  MessageContentArtifact,
  MessageContentAudio,
  MessageContentDocument,
  MessageContentImage,
  MessageContentText,
  MessageContentVideo,
  MessageRole,
  ReasoningMessage,
  ToolCallMessage,
  ToolResponseExecution,
  ToolResponseMessage,
  UserMessage,
};
