import { z } from 'zod';

import { type ArtifactRef, artifactRefSchema } from './artifacts.js';
import { httpUrlSchema } from './schemas.js';

const CONTENT_MODALITIES = ['text', 'image', 'audio', 'video', 'document'] as const;
const MEDIA_MODALITIES = ['image', 'audio', 'video', 'document'] as const;

type ContentModality = (typeof CONTENT_MODALITIES)[number];
type MediaModality = (typeof MEDIA_MODALITIES)[number];

interface ContentSourceUrl {
  readonly mediaType?: string;
  readonly type: 'url';
  readonly url: string;
}

type ContentSource = ContentSourceUrl;

interface ContentText {
  readonly text: string;
  readonly type: 'text';
}

interface ContentArtifact {
  readonly artifact: ArtifactRef;
  readonly type: 'artifact';
}

interface ContentMedia<TType extends MediaModality = MediaModality> {
  readonly source: ContentSource;
  readonly type: TType;
}

type ContentImage = ContentMedia<'image'>;
type ContentAudio = ContentMedia<'audio'>;
type ContentVideo = ContentMedia<'video'>;
type ContentDocument = ContentMedia<'document'>;
type ContentPart =
  ContentArtifact | ContentAudio | ContentDocument | ContentImage | ContentText | ContentVideo;

const mediaTypeSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i, 'Use an Internet media type.');
const contentSourceSchema = z.object({
  mediaType: mediaTypeSchema.optional(),
  type: z.literal('url'),
  url: httpUrlSchema('An absolute HTTP(S) URL carrying media content.'),
});
const contentArtifactSchema = z.object({
  artifact: artifactRefSchema,
  type: z.literal('artifact'),
});
const contentTextSchema = z.object({ text: z.string().max(32_000), type: z.literal('text') });
const contentImageSchema = z.object({ source: contentSourceSchema, type: z.literal('image') });
const contentAudioSchema = z.object({ source: contentSourceSchema, type: z.literal('audio') });
const contentVideoSchema = z.object({ source: contentSourceSchema, type: z.literal('video') });
const contentDocumentSchema = z.object({
  source: contentSourceSchema,
  type: z.literal('document'),
});
const contentPartSchema = z
  .discriminatedUnion('type', [
    contentTextSchema,
    contentArtifactSchema,
    contentImageSchema,
    contentAudioSchema,
    contentVideoSchema,
    contentDocumentSchema,
  ])
  .superRefine((part, context) => {
    if (part.type === 'artifact' || part.type === 'text') return;
    const mediaType = part.source.mediaType;
    if (mediaType === undefined) return;
    const matches =
      part.type === 'document'
        ? !/^(audio|image|video)\//i.test(mediaType)
        : mediaType.toLowerCase().startsWith(`${part.type}/`);
    if (!matches) {
      context.addIssue({
        code: 'custom',
        message: `${mediaType} does not match ${part.type} content.`,
        path: ['source', 'mediaType'],
      });
    }
  });
const speechContentSchema = z
  .array(z.discriminatedUnion('type', [contentTextSchema, contentArtifactSchema]))
  .min(1)
  .max(16)
  .refine(
    (content) => content.some((part) => part.type !== 'text' || part.text.trim().length > 0),
    'Provide non-blank text or media content.',
  );

function contentToString(content: readonly ContentPart[]): string {
  return content
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'artifact') {
        const name = part.artifact.filename ?? part.artifact.artifactId;
        return (
          `[Artifact: ${name}; ID: ${part.artifact.artifactId}; ` +
          `Type: ${part.artifact.mediaType}; Bytes: ${String(part.artifact.size)}]`
        );
      }
      const label = part.type.charAt(0).toUpperCase() + part.type.slice(1);
      return `[${label}: ${part.source.url}]`;
    })
    .join('\n');
}

function mediaTypeOf(part: ContentMedia): string | undefined {
  return part.source.mediaType;
}

function textFromContent(content: readonly ContentPart[], separator = ''): string {
  return content
    .filter((part): part is ContentText => part.type === 'text')
    .map((part) => part.text)
    .join(separator);
}

function modalitiesIn(content: readonly ContentPart[]): ReadonlySet<ContentModality> {
  return new Set(
    content.flatMap((part): ContentModality[] => (part.type === 'artifact' ? [] : [part.type])),
  );
}

function hasUsableContent(content: readonly ContentPart[]): boolean {
  return content.some((part) => part.type !== 'text' || part.text.trim().length > 0);
}

interface PrincipalRef {
  readonly issuer: string;
  readonly subject: string;
}

interface MessageOrigin {
  /**
   * What the transport calls this principal, when it has a name for it.
   *
   * Presentation only, and never an identity: `principal` is what anything is
   * decided from. A display name is chosen by the person, is not unique, and
   * changes without anything else changing — so it goes beside the subject
   * rather than into it, and nothing compares or matches on it.
   *
   * It exists because a shared transcript that names everyone by opaque ID is
   * one the model cannot talk about. Absent leaves the reader with the subject,
   * which is what every surface had before.
   */
  readonly displayName?: string;
  readonly principal: PrincipalRef;
  readonly transportMessageId: string;
}

function principalToString(reference: PrincipalRef): string {
  return `${reference.issuer}:${reference.subject}`;
}

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

/**
 * Tool traffic the model has already consumed, replaced by a record of it.
 *
 * A fold takes the place of its first folded message, which is the whole of
 * what fixes its position: the messages it replaces are the messages it stands
 * in for, and it stands where they stood.
 */
interface FoldedMessage extends MessageBase {
  readonly role: 'folded';
  readonly foldedMessageIds: readonly string[];
  readonly content: readonly MessageContent[];
}

interface ReasoningMessage extends MessageBase {
  readonly role: 'reasoning';
  readonly content: readonly MessageContent[];
}

/**
 * How something someone said reached the agent.
 *
 * `message` and `steer` are both addressed to Nox and both start or join a run.
 * `observation` is not addressed to it at all: it is what else was said in a
 * shared room, kept because a transcript that omits it is a false record of the
 * conversation. It carries its speaker's principal like anything else and grants
 * nothing — no run ever executes under an observation's authority.
 */
type UserMessageDelivery = 'message' | 'observation' | 'steer';

interface UserMessage extends MessageBase {
  readonly role: 'user';
  readonly content: readonly MessageContent[];
  readonly delivery?: UserMessageDelivery;
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
type ToolOutputTrust = 'trusted' | 'untrusted';

interface ToolResponseMessage extends MessageBase {
  readonly role: 'toolResponse';
  readonly name: string;
  readonly trackId: string;
  readonly execution: ToolResponseExecution;
  readonly response: readonly MessageContent[];
  readonly trust: ToolOutputTrust;
  readonly isError?: boolean;
}

type Message =
  | AssistantMessage
  | CompactedMessage
  | FoldedMessage
  | ReasoningMessage
  | ToolCallMessage
  | ToolResponseMessage
  | UserMessage;
type ContentMessage =
  AssistantMessage | CompactedMessage | FoldedMessage | ReasoningMessage | UserMessage;
type MessageRole = Message['role'];

function timestampForModel(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: '2-digit',
    timeZone,
    timeZoneName: 'shortOffset',
    year: 'numeric',
  })
    .format(at)
    .replace(',', '');
}

function userContentForModel(message: UserMessage, timeZone = 'UTC'): readonly MessageContent[] {
  const said = timestampForModel(message.createdAt, timeZone);
  return [
    { text: `[from ${originToString(message.origin)} · ${said}]\n`, type: 'text' },
    ...message.content,
  ];
}

export {
  CONTENT_MODALITIES,
  contentArtifactSchema,
  contentAudioSchema,
  contentDocumentSchema,
  contentImageSchema,
  contentPartSchema,
  contentSourceSchema,
  contentTextSchema,
  contentToString,
  contentVideoSchema,
  hasUsableContent,
  MEDIA_MODALITIES,
  mediaTypeOf,
  modalitiesIn,
  originToString,
  principalToString,
  speechContentSchema,
  textFromContent,
  timestampForModel,
  TOOL_RESPONSE_EXECUTIONS,
  userContentForModel,
};

export type {
  AssistantMessage,
  CompactedMessage,
  ContentArtifact,
  ContentAudio,
  ContentDocument,
  ContentImage,
  ContentMedia,
  ContentMessage,
  ContentModality,
  ContentPart,
  ContentSource,
  ContentSourceUrl,
  ContentText,
  ContentVideo,
  FoldedMessage,
  MediaModality,
  Message,
  MessageContent,
  MessageContentArtifact,
  MessageContentAudio,
  MessageContentDocument,
  MessageContentImage,
  MessageContentText,
  MessageContentVideo,
  MessageOrigin,
  MessageRole,
  PrincipalRef,
  ReasoningMessage,
  ToolCallMessage,
  ToolResponseExecution,
  ToolResponseMessage,
  UserMessage,
  UserMessageDelivery,
};
