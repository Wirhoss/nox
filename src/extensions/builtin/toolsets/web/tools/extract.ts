import {
  type ArtifactOutputPublisher,
  httpUrlSchema,
  type MessageContent,
  stableStringify,
  type Tool,
  z,
} from '@nox/extension-api';

import {
  harvestImages,
  pageFilename,
  publishBytes,
  type PublishedImage,
  publishText,
} from '../artifacts';

import type { ExtractCapability, ExtractedPage, PageCapture } from '../capabilities';

const WEB_EXTRACT_AUTHORITY = 'nox.toolset.web.extract';

/** One picture is allowed to be big; none of them is allowed to be unbounded. */
const MAX_IMAGE_BYTES = 8_000_000;

/** Links are evidence of where a page leads, not a copy of the page's navigation. */
const MAX_LINKS = 40;

interface PageReport {
  readonly artifacts: Readonly<Record<string, string>>;
  readonly error?: string;
  readonly excerpt?: string;
  readonly images?: readonly PublishedImage[];
  readonly linkCount?: number;
  readonly links?: readonly { text?: string; url: string }[];
  readonly title?: string;
  readonly url: string;
}

function extractParameters(capability: ExtractCapability) {
  return z.object({
    capture: z
      .array(z.enum(capability.captures as [PageCapture, ...PageCapture[]]))
      .min(1)
      .default([...capability.defaultCaptures])
      .describe(
        'What to bring back from each page as durable files: ' +
          `${capability.captures.join(', ')}.`,
      ),
    excerptCharacters: z
      .number()
      .int()
      .nonnegative()
      .max(20_000)
      .default(1_500)
      .describe('Characters of page text to include inline. 0 returns files only.'),
    maxImages: z
      .number()
      .int()
      .nonnegative()
      .max(25)
      .default(8)
      .describe('Maximum images to download and publish for each page.'),
    urls: z
      .array(httpUrlSchema('A public page URL to extract.'))
      .min(1)
      .max(capability.maxUrls)
      .describe('The page URLs to extract in one batch.'),
  });
}

/**
 * Extraction whose result is the page, not a retelling of it.
 *
 * The old shape returned Markdown and dropped everything a page is besides
 * prose. Here each page arrives as files — its cleaned HTML, its pictures, a
 * rendering, a PDF — published as artifacts the agent can show or hand on, while
 * the transcript keeps the small part that has to be read: what the page is,
 * where its images went, and a bounded excerpt so the model knows what it
 * fetched without carrying the whole document forever.
 */
function extractTool(capability: ExtractCapability): Tool {
  const parameters = extractParameters(capability);

  const tool: Tool<typeof parameters> = {
    authority: WEB_EXTRACT_AUTHORITY,
    description:
      'Extract public web pages as durable files — cleaned HTML, the page images, ' +
      'and optionally a screenshot, PDF or Markdown — plus a short inline excerpt.',
    name: 'web_extract',
    output: { artifacts: true },
    parameters,
    prepare: (params) => ({
      risk: {
        effects: ['network', 'read', 'write'],
        resources: [
          ...params.urls.map((url) => ({ kind: 'url' as const, value: url })),
          { kind: 'file' as const, value: 'conversation artifact output' },
        ],
        reversible: true,
        volume: params.urls.length,
      },
      run: async ({ abortSignal, artifacts }): Promise<MessageContent[]> => {
        if (artifacts === undefined) {
          throw new Error('Artifact output is not available in this session.');
        }

        const pages = await capability.extract(
          { captures: params.capture, urls: params.urls },
          { signal: abortSignal },
        );

        const published: MessageContent[] = [];
        const reports: PageReport[] = [];
        for (const [index, page] of pages.entries()) {
          const report = await publishPage(page, index, {
            artifacts,
            maxImages: params.capture.includes('images') ? params.maxImages : 0,
            published,
            signal: abortSignal,
            excerptCharacters: params.excerptCharacters,
          });
          reports.push(report);
        }

        return [{ text: stableStringify({ pages: reports }), type: 'text' }, ...published];
      },
      title: `Extract ${String(params.urls.length)} web page${params.urls.length === 1 ? '' : 's'}`,
      type: 'immediate',
    }),
    risk: { effects: ['network', 'read', 'write'], reversible: true },
  };

  return tool;
}

interface PublishOptions {
  readonly artifacts: ArtifactOutputPublisher;
  readonly excerptCharacters: number;
  readonly maxImages: number;
  readonly published: MessageContent[];
  readonly signal: AbortSignal;
}

async function publishPage(
  page: ExtractedPage,
  index: number,
  options: PublishOptions,
): Promise<PageReport> {
  if (page.error !== undefined) {
    return Object.freeze({ artifacts: {}, error: page.error, url: page.url });
  }

  const artifacts: Record<string, string> = {};
  const publishAs = async (kind: string, text: string, mediaType: string): Promise<void> => {
    const artifact = await publishText(
      options.artifacts,
      text,
      mediaType,
      pageFilename(page.title, page.url, mediaType, index),
    );
    options.published.push(artifact);
    artifacts[kind] = artifact.artifact.artifactId;
  };

  if (page.html !== undefined && page.html.length > 0) {
    await publishAs('html', page.html, 'text/html');
  }
  if (page.markdown !== undefined && page.markdown.length > 0) {
    await publishAs('markdown', page.markdown, 'text/markdown');
  }
  if (page.screenshot !== undefined) {
    const artifact = await publishBytes(
      options.artifacts,
      page.screenshot,
      pageFilename(page.title, page.url, page.screenshot.mediaType, index),
    );
    options.published.push(artifact);
    artifacts.screenshot = artifact.artifact.artifactId;
  }
  if (page.pdf !== undefined) {
    const artifact = await publishBytes(
      options.artifacts,
      page.pdf,
      pageFilename(page.title, page.url, page.pdf.mediaType, index),
    );
    options.published.push(artifact);
    artifacts.pdf = artifact.artifact.artifactId;
  }

  const harvest =
    options.maxImages > 0 && page.images !== undefined && page.images.length > 0
      ? await harvestImages(page.images, {
          maxBytes: MAX_IMAGE_BYTES,
          maxImages: options.maxImages,
          publisher: options.artifacts,
          signal: options.signal,
        })
      : undefined;
  options.published.push(...(harvest?.parts ?? []));
  const images = harvest?.images;

  const excerpt = excerptOf(page, options.excerptCharacters);
  const links = page.links ?? [];

  return Object.freeze({
    artifacts: Object.freeze(artifacts),
    ...(excerpt === undefined ? {} : { excerpt }),
    ...(images === undefined || images.length === 0 ? {} : { images }),
    ...(links.length === 0
      ? {}
      : { linkCount: links.length, links: Object.freeze(links.slice(0, MAX_LINKS)) }),
    ...(page.title === undefined ? {} : { title: page.title }),
    url: page.url,
  });
}

/**
 * Enough of the page for the model to know what it fetched. Taken from Markdown
 * when the module produced it and from the markup otherwise, because an excerpt
 * of raw HTML is mostly tags — and tags are what the artifact already holds.
 */
function excerptOf(page: ExtractedPage, characters: number): string | undefined {
  if (characters === 0) return undefined;

  const source =
    page.markdown !== undefined && page.markdown.length > 0
      ? page.markdown
      : textOf(page.html ?? '');
  const trimmed = source.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > characters ? `${trimmed.slice(0, characters)}…` : trimmed;
}

function textOf(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ');
}

export { extractTool, WEB_EXTRACT_AUTHORITY };
