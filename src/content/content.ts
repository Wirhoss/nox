import { z } from 'zod';

import { httpUrlSchema } from '../config/url';

/**
 * Modalities understood by Nox's content envelope.
 *
 * This is deliberately independent from any provider API. A provider may support
 * only a subset and must translate or refuse the rest explicitly; the transcript,
 * tools and brokers must not silently turn non-text content into prose first.
 */
const CONTENT_MODALITIES = ['text', 'image', 'audio', 'video', 'document'] as const;
const MEDIA_MODALITIES = ['image', 'audio', 'video', 'document'] as const;

type ContentModality = (typeof CONTENT_MODALITIES)[number];
type MediaModality = (typeof MEDIA_MODALITIES)[number];

interface ContentSourceBase64 {
  readonly data: string;
  readonly mediaType: string;
  readonly type: 'base64';
}

interface ContentSourceUrl {
  /** Optional when the remote server is expected to report its own Content-Type. */
  readonly mediaType?: string;
  readonly type: 'url';
  readonly url: string;
}

type ContentSource = ContentSourceBase64 | ContentSourceUrl;

interface ContentText {
  readonly text: string;
  readonly type: 'text';
}

interface ContentMedia<TType extends MediaModality = MediaModality> {
  readonly source: ContentSource;
  readonly type: TType;
}

type ContentImage = ContentMedia<'image'>;
type ContentAudio = ContentMedia<'audio'>;
type ContentVideo = ContentMedia<'video'>;
type ContentDocument = ContentMedia<'document'>;
type ContentPart = ContentAudio | ContentDocument | ContentImage | ContentText | ContentVideo;

const mediaTypeSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i, 'Use an Internet media type.');

const contentSourceSchema = z.discriminatedUnion('type', [
  z.object({
    // 5 MiB of bytes is at most ~7 MiB of base64. The bound belongs at the
    // ingress schema so a broker cannot turn one chat turn into unbounded JSON.
    data: z.string().min(1).max(7_000_000),
    mediaType: mediaTypeSchema,
    type: z.literal('base64'),
  }),
  z.object({
    mediaType: mediaTypeSchema.optional(),
    type: z.literal('url'),
    url: httpUrlSchema('An absolute HTTP(S) URL carrying media content.'),
  }),
]);

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
    contentImageSchema,
    contentAudioSchema,
    contentVideoSchema,
    contentDocumentSchema,
  ])
  .superRefine((part, context) => {
    if (part.type === 'text') return;
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

/** Content that can start a turn: at least one non-blank text or media part. */
const speechContentSchema = z
  .array(contentPartSchema)
  .min(1)
  .max(16)
  .refine(
    (content) => content.some((part) => part.type !== 'text' || part.text.trim().length > 0),
    'Provide non-blank text or media content.',
  );

function mediaTypeOf(part: ContentMedia): string | undefined {
  return part.source.mediaType;
}

/** Plain-text projection for search, logs and transports that explicitly need prose. */
function contentToString(content: readonly ContentPart[]): string {
  return content
    .map((part) => {
      if (part.type === 'text') return part.text;

      const label = part.type.charAt(0).toUpperCase() + part.type.slice(1);
      if (part.source.type === 'url') return `[${label}: ${part.source.url}]`;
      return `[${label}: ${part.source.mediaType}]`;
    })
    .join('\n');
}

/** Text parts only. It never pretends a media placeholder is the media itself. */
function textFromContent(content: readonly ContentPart[], separator = ''): string {
  return content
    .filter((part): part is ContentText => part.type === 'text')
    .map((part) => part.text)
    .join(separator);
}

function modalitiesIn(content: readonly ContentPart[]): ReadonlySet<ContentModality> {
  return new Set(content.map((part) => part.type));
}

function hasUsableContent(content: readonly ContentPart[]): boolean {
  return content.some((part) => part.type !== 'text' || part.text.trim().length > 0);
}

export {
  CONTENT_MODALITIES,
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
  speechContentSchema,
  textFromContent,
};

export type {
  ContentAudio,
  ContentDocument,
  ContentImage,
  ContentMedia,
  ContentModality,
  ContentPart,
  ContentSource,
  ContentSourceBase64,
  ContentSourceUrl,
  ContentText,
  ContentVideo,
  MediaModality,
};
