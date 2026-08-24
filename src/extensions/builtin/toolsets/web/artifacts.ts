import { isPrivateHost, publicUrl } from './http';

import type { ArtifactOutputPublisher } from '../../../../artifact/output';
import type { ContentArtifact } from '../../../../content/content';
import type { PageBytes, PageImage } from './capabilities';

/**
 * Turning what a page is made of into files.
 *
 * A page is not a string. It is markup, pictures, a rendering, sometimes a PDF —
 * and returning a Markdown transcription of all that was throwing away
 * everything the transcript cannot hold. Artifacts are where those belong: the
 * bytes live in the pipeline, the transcript carries a reference, and the agent
 * can hand any of them to whoever asked without the model having to describe
 * them from memory.
 */

/** Extensions Nox names its own files with, per media type it publishes here. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'text/html': 'html',
  'text/markdown': 'md',
};

interface PublishedImage {
  readonly alt?: string;
  readonly artifactId?: string;
  /** Why this image is a URL and not a file, when it is. */
  readonly skipped?: string;
  readonly url: string;
}

interface ImageHarvestOptions {
  readonly maxBytes: number;
  readonly maxImages: number;
  readonly publisher: ArtifactOutputPublisher;
  readonly signal: AbortSignal;
}

/**
 * What the harvest produced, in the two forms the caller needs it: the record
 * the model reads, and the artifact references the transcript carries. They are
 * returned together because they describe the same files, and building either
 * without the other would leave a published file the conversation cannot name.
 */
interface ImageHarvest {
  readonly images: readonly PublishedImage[];
  readonly parts: readonly ContentArtifact[];
}

/**
 * A filename that reads like the page it came from, and cannot be anything else.
 *
 * The stem is a page's own title, which is attacker-controlled text: it is
 * stripped of the separators and control characters that make a name mean
 * something to a filesystem, bounded, and replaced outright when nothing usable
 * survives. Collisions are the artifact pipeline's business — a filename here is
 * a label, never an identity.
 */
function pageFilename(hint: string | undefined, url: string, mediaType: string, index = 0): string {
  const extension = EXTENSIONS[mediaType] ?? 'bin';
  let fallback = `page-${String(index + 1)}`;
  try {
    const parsed = new URL(url);
    fallback = `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    // An echoed URL can be absent or malformed; the positional name still holds.
  }

  const source = hint !== undefined && hint.trim().length > 0 ? hint : fallback;
  const stem = Array.from(source.normalize('NFKC'), (character) =>
    (character.codePointAt(0) ?? 0) < 32 ? '-' : character,
  )
    .join('')
    .replace(/[<>:"/\u005C|?*]/gu, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 200);

  return `${stem.length === 0 ? `page-${String(index + 1)}` : stem}.${extension}`;
}

/** Publishes bytes a module already holds, such as a rendering or a PDF. */
function publishBytes(
  publisher: ArtifactOutputPublisher,
  bytes: PageBytes,
  filename: string,
): Promise<ContentArtifact> {
  return publisher.publish({
    data: new Blob([bytes.bytes], { type: bytes.mediaType }),
    declaredMediaType: bytes.mediaType,
    filename,
  });
}

function publishText(
  publisher: ArtifactOutputPublisher,
  text: string,
  mediaType: string,
  filename: string,
): Promise<ContentArtifact> {
  return publisher.publish({
    data: new Blob([text], { type: mediaType }),
    declaredMediaType: mediaType,
    filename,
  });
}

/**
 * Fetches the pictures a page pointed at and publishes each as its own file.
 *
 * Bounded on both axes, because this is the one place a tool call fans out into
 * requests nobody wrote down: a page can name a thousand images and a single one
 * of them can be a gigabyte. What exceeds either bound stays a URL with the
 * reason recorded, which is still an answer — the model keeps the address it can
 * pass to a later call, and nothing about the failure is silent.
 */
async function harvestImages(
  images: readonly PageImage[],
  options: ImageHarvestOptions,
): Promise<ImageHarvest> {
  const harvested: PublishedImage[] = [];
  const parts: ContentArtifact[] = [];

  for (const image of images.slice(0, options.maxImages)) {
    const url = publicUrl(image.url);
    if (url === undefined) continue;
    const label = image.alt === undefined || image.alt.trim().length === 0 ? undefined : image.alt;

    // Nox is the one making this request, from inside its own network. A page
    // does not get to choose an address there.
    if (isPrivateHost(new URL(url).hostname)) {
      harvested.push({
        ...(label === undefined ? {} : { alt: label }),
        skipped: 'not a public address',
        url,
      });
      continue;
    }

    try {
      const response = await fetch(url, { redirect: 'follow', signal: options.signal });
      if (!response.ok) {
        harvested.push({
          ...(label === undefined ? {} : { alt: label }),
          skipped: `HTTP ${String(response.status)}`,
          url,
        });
        continue;
      }

      const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
      if (!mediaType.toLowerCase().startsWith('image/')) {
        await response.body?.cancel();
        harvested.push({
          ...(label === undefined ? {} : { alt: label }),
          skipped: `not an image (${mediaType})`,
          url,
        });
        continue;
      }

      const bytes = await boundedBytes(response, options.maxBytes);
      if (bytes === undefined) {
        harvested.push({
          ...(label === undefined ? {} : { alt: label }),
          skipped: `larger than ${String(options.maxBytes)} bytes`,
          url,
        });
        continue;
      }

      const artifact = await publishBytes(
        options.publisher,
        { bytes, mediaType },
        pageFilename(label, url, mediaType, harvested.length),
      );
      parts.push(artifact);
      harvested.push({
        ...(label === undefined ? {} : { alt: label }),
        artifactId: artifact.artifact.artifactId,
        url,
      });
    } catch (error) {
      if (options.signal.aborted) throw error;
      harvested.push({
        ...(label === undefined ? {} : { alt: label }),
        skipped: error instanceof Error ? error.message : String(error),
        url,
      });
    }
  }

  return Object.freeze({ images: Object.freeze(harvested), parts: Object.freeze(parts) });
}

/**
 * The body, or nothing once it passes the ceiling. Read as a stream rather than
 * trusted to `content-length`: a header is a claim, and the bound has to hold
 * for a server that lied about it or never said.
 */
async function boundedBytes(response: Response, maxBytes: number): Promise<Uint8Array | undefined> {
  const body = response.body;
  if (body === null) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export { harvestImages, pageFilename, publishBytes, publishText };

export type { ImageHarvest, ImageHarvestOptions, PublishedImage };
