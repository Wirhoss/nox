import type { DiscordUpload } from './rest';
import type {
  ArtifactPipeline,
  ArtifactScope,
  ContentArtifact,
  Logger,
  MessageContent,
  RepresentationProfile,
} from '@nox/extension-api';

/**
 * The largest file this transport will put on a message.
 *
 * Discord's own ceiling depends on the guild's boost tier, and framing a
 * multipart body means holding the bytes, so this is the point past which
 * sending is not attempted at all. Discord refusing something smaller is not a
 * different case and is answered the same way: the channel is told which file
 * did not make it rather than left with a reply that quietly lost half of itself.
 */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * The file as it is, not a reading of it. A transport that posts an attachment
 * is posting the artifact itself, so the profile accepts every media type and
 * asks for no transform, which is what makes the pipeline hand back the original
 * rather than look for a processor.
 */
const UPLOAD_PROFILE: RepresentationProfile = Object.freeze({
  id: 'nox.broker.discord.upload',
  mediaTypes: Object.freeze(['*/*']),
  version: 1,
});

/** One file on a Discord message, as the gateway payload describes it. */
interface DiscordAttachment {
  readonly content_type?: string;
  readonly filename?: string;
  readonly id: string;
  readonly size?: number;
  readonly url: string;
}

/**
 * What moving bytes between Discord and Nox's artifact store needs.
 *
 * The scope comes from the host, which is the only thing that knows where a
 * conversation's files live. Both directions are handed the same one on purpose:
 * a file stored under one scope and read back under another is a file that
 * arrives and can never be sent again.
 */
interface ArtifactOptions {
  readonly logger: Logger;
  readonly pipeline: ArtifactPipeline | undefined;
  readonly scope: ArtifactScope;
  readonly signal: AbortSignal;
}

type IngestOptions = ArtifactOptions;
type UploadOptions = ArtifactOptions;

function attachmentsOf(value: unknown): readonly DiscordAttachment[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry): DiscordAttachment[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : undefined;
    const url = typeof record.url === 'string' ? record.url : undefined;
    if (id === undefined || url === undefined) return [];

    return [
      {
        ...(typeof record.content_type === 'string' ? { content_type: record.content_type } : {}),
        ...(typeof record.filename === 'string' ? { filename: record.filename } : {}),
        id,
        ...(typeof record.size === 'number' ? { size: record.size } : {}),
        url,
      },
    ];
  });
}

/**
 * Pulls one attachment into Nox's artifact store and answers with the reference
 * that stands for it in a message. Bytes are streamed, never read into memory,
 * and the media type Discord declared is passed as declared: the pipeline
 * detects the real one and keeps both, which is what makes a file that lied
 * about itself visible instead of trusted.
 *
 * The scope is the conversation's, as the host names it: an artifact posted
 * into a channel belongs to that channel's transcript and to nothing else — a
 * reference that leaked across conversations would be a way to read another
 * room's files by ID.
 */
async function ingestAttachment(
  attachment: DiscordAttachment,
  options: IngestOptions,
): Promise<ContentArtifact | undefined> {
  const { logger, pipeline, scope, signal } = options;
  if (pipeline === undefined) return undefined;

  try {
    const response = await fetch(attachment.url, { signal });
    if (!response.ok || response.body === null) {
      logger.warn(
        { attachment: attachment.id, status: response.status },
        'Could not download a Discord attachment.',
      );
      return undefined;
    }

    const record = await pipeline.ingest({
      data: response.body,
      ...(attachment.content_type === undefined
        ? {}
        : { declaredMediaType: attachment.content_type }),
      ...(attachment.filename === undefined ? {} : { filename: attachment.filename }),
      // `broker` is the provenance for bytes that arrived over a transport: not
      // something a tool produced, and not something Nox derived.
      provenance: { details: { attachmentId: attachment.id }, type: 'broker' },
      scope,
      signal,
    });

    return {
      artifact: {
        artifactId: record.artifactId,
        ...(record.filename === undefined ? {} : { filename: record.filename }),
        mediaType: record.mediaType,
        size: record.size,
      },
      type: 'artifact',
    };
  } catch (error) {
    // A file that could not be stored is not a message that did not happen. The
    // text still reaches the agent, and the loss is reported rather than hidden.
    logger.warn(
      { attachment: attachment.id, err: error },
      'Could not ingest a Discord attachment.',
    );
    return undefined;
  }
}

/**
 * One Discord message as content Nox can carry: what was typed, and a reference
 * for each file that came with it.
 *
 * Inbound speech accepts text and artifact references and nothing else, which is
 * exactly right for this: a transport hands over a durable reference to bytes
 * Nox owns, never a remote URL that expires and never the bytes inline.
 */
async function toMessageContent(
  text: string,
  raw: unknown,
  options: IngestOptions,
): Promise<readonly MessageContent[]> {
  const parts: MessageContent[] = [];
  const trimmed = text.trim();
  if (trimmed.length > 0) parts.push({ text: trimmed, type: 'text' });

  for (const attachment of attachmentsOf(raw)) {
    const part = await ingestAttachment(attachment, options);
    if (part !== undefined) parts.push(part);
  }

  return parts;
}

/**
 * A name Discord will take. A stored artifact carries whatever filename it
 * arrived with, and a path separator in one is how a file ends up posted under a
 * name that is not the one it was given.
 */
function uploadName(reference: ContentArtifact['artifact']): string {
  const raw = reference.filename ?? reference.artifactId;
  const cleaned = raw.replaceAll(/[/\\]/gu, '_').trim();
  return cleaned.length === 0 ? reference.artifactId : cleaned.slice(0, 200);
}

/**
 * One artifact as bytes ready to post, or nothing when it cannot be sent.
 *
 * Read under the conversation's own scope, so an ID is only ever readable in the
 * conversation it belongs to. Nothing here relies on where the ID came from: an
 * artifact from another room resolves to nothing and is reported as a file that
 * could not be posted, which is the same answer as any other file this transport
 * cannot send.
 */
async function toUpload(
  reference: ContentArtifact['artifact'],
  options: UploadOptions,
): Promise<DiscordUpload | undefined> {
  const { logger, pipeline, signal } = options;
  if (pipeline === undefined) return undefined;
  if (reference.size > MAX_UPLOAD_BYTES) {
    logger.info(
      { artifactId: reference.artifactId, size: reference.size },
      'Not posting a Discord attachment: it is past what a message can carry.',
    );
    return undefined;
  }

  try {
    const payload = await pipeline.resolve(reference.artifactId, UPLOAD_PROFILE, {
      scope: options.scope,
      signal,
    });
    const bytes = new Uint8Array(await new Response(payload.stream).arrayBuffer());
    return {
      bytes,
      filename: uploadName(reference),
      mediaType: payload.representation.mediaType,
    };
  } catch (error) {
    logger.warn(
      { artifactId: reference.artifactId, err: error },
      'Could not read an artifact to post it to Discord.',
    );
    return undefined;
  }
}

/**
 * The files on one outbound message, and the names of the ones that could not be
 * sent.
 *
 * Both halves are answered because a message is not only its text: an artifact
 * that is dropped silently is a reply that lost the thing it was about, so what
 * did not go up is named and the channel is told.
 */
async function toUploads(
  content: readonly MessageContent[],
  options: UploadOptions,
): Promise<{ readonly missed: readonly string[]; readonly uploads: readonly DiscordUpload[] }> {
  const missed: string[] = [];
  const uploads: DiscordUpload[] = [];

  for (const part of content) {
    if (part.type !== 'artifact') continue;

    const upload = await toUpload(part.artifact, options);
    if (upload === undefined) missed.push(uploadName(part.artifact));
    else uploads.push(upload);
  }

  return { missed, uploads };
}

export {
  attachmentsOf,
  ingestAttachment,
  MAX_UPLOAD_BYTES,
  toMessageContent,
  toUpload,
  toUploads,
  UPLOAD_PROFILE,
};

export type { ArtifactOptions, DiscordAttachment, IngestOptions, UploadOptions };
