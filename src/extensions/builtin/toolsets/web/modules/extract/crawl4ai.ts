import { z } from 'zod';

import { PAGE_CAPTURES } from '../../capabilities';
import { decodeBase64, publicUrl, WebService } from '../../http';
import { endpointFields, runtimeCredentialSchema } from '../../module';

import type {
  ExtractCapability,
  ExtractedPage,
  ExtractRequest,
  PageBytes,
  PageCapture,
  PageImage,
  PageLink,
  WebRequestContext,
} from '../../capabilities';
import type { WebModule, WebModuleConfig } from '../../module';

/**
 * Crawl4AI: a browser-backed crawler that returns a rendered page rather than a
 * download of its source.
 *
 * Which captures it can produce is a property of this service and is declared as
 * one. A module wired to something that only ever returns text says so, and the
 * extract tool then never offers a screenshot nobody could have taken.
 */
const CRAWL4AI_CAPTURES = Object.freeze([...PAGE_CAPTURES]);

function crawl4aiFields<TCredential extends z.ZodType>(credential: TCredential) {
  return {
    ...endpointFields(credential, {
      timeoutMs: 120_000,
      url: 'The base URL of the Crawl4AI service. Nox posts batches to /crawl.',
    }),
    defaultCaptures: z
      .array(z.enum(PAGE_CAPTURES))
      .min(1)
      .default(['html', 'images'])
      .meta({ nox: { help: 'ui.crawl4ai.capturesHelp', label: 'ui.crawl4ai.captures' } }),
    maxUrls: z
      .number()
      .int()
      .positive()
      .max(25)
      .default(5)
      .meta({ nox: { label: 'ui.maximumUrls' } }),
    waitUntil: z
      .enum(['domcontentloaded', 'load', 'networkidle'])
      .default('domcontentloaded')
      .meta({ nox: { help: 'ui.crawl4ai.waitUntilHelp', label: 'ui.crawl4ai.waitUntil' } }),
  };
}

const crawl4aiConfigSchema = z.object(crawl4aiFields(runtimeCredentialSchema));

type Crawl4aiConfig = z.infer<typeof crawl4aiConfigSchema>;

interface CrawlImage {
  alt?: string;
  desc?: string;
  height?: number;
  src?: string;
  width?: number;
}

interface CrawlLink {
  href?: string;
  text?: string;
}

interface CrawlResult {
  cleaned_html?: string;
  error_message?: string;
  html?: string;
  links?: { external?: CrawlLink[]; internal?: CrawlLink[] };
  markdown?:
    | string
    | {
        fit_markdown?: string;
        markdown_with_citations?: string;
        raw_markdown?: string;
      };
  media?: { images?: CrawlImage[] };
  metadata?: { title?: string };
  pdf?: string;
  screenshot?: string;
  success?: boolean;
  url?: string;
}

class Crawl4aiExtract implements ExtractCapability {
  readonly #config: Crawl4aiConfig;
  readonly #service: WebService;

  constructor(config: Crawl4aiConfig) {
    this.#config = config;
    this.#service = new WebService('Crawl4AI', config);
  }

  public get captures(): readonly PageCapture[] {
    return CRAWL4AI_CAPTURES;
  }

  public get defaultCaptures(): readonly PageCapture[] {
    return this.#config.defaultCaptures;
  }

  public get origin(): string {
    return this.#service.origin;
  }

  public get maxUrls(): number {
    return this.#config.maxUrls;
  }

  public async extract(
    request: ExtractRequest,
    context: WebRequestContext,
  ): Promise<readonly ExtractedPage[]> {
    const wanted = new Set(request.captures);
    const body = await this.#service.json<unknown>('/crawl', {
      body: {
        browser_config: { params: { headless: true }, type: 'BrowserConfig' },
        crawler_config: {
          params: {
            pdf: wanted.has('pdf'),
            screenshot: wanted.has('screenshot'),
            stream: false,
            wait_until: this.#config.waitUntil,
          },
          type: 'CrawlerRunConfig',
        },
        urls: [...request.urls],
      },
      signal: context.signal,
    });

    const results = crawlResults(body);
    return Object.freeze(
      request.urls.map((requested, index) => {
        const result = results[index];
        if (result === undefined) {
          return Object.freeze({
            error: 'Crawl4AI returned no result for this URL.',
            url: requested,
          });
        }
        return page(result, requested, wanted);
      }),
    );
  }
}

/**
 * The results, whichever envelope this Crawl4AI version put them in. Versions
 * differ on `results`, `result` and a bare object, and a module that knew only
 * one of them would report a working service as a broken one.
 */
function crawlResults(body: unknown): readonly CrawlResult[] {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Crawl4AI returned an invalid response.');
  }

  const response = body as { result?: CrawlResult; results?: CrawlResult[]; success?: boolean };
  if (response.success === false) throw new Error('Crawl4AI refused the crawl request.');
  if (response.results !== undefined) return response.results;
  return [response.result ?? body];
}

/**
 * One result, kept as a result even when the page failed. A dead URL in a batch
 * is a fact about that URL, and throwing would lose the pages beside it.
 */
function page(
  result: CrawlResult,
  requested: string,
  wanted: ReadonlySet<PageCapture>,
): ExtractedPage {
  const url = result.url ?? requested;
  if (result.success === false) {
    return Object.freeze({
      error: result.error_message ?? 'Crawl4AI could not crawl this page.',
      url,
    });
  }

  const screenshot = wanted.has('screenshot')
    ? bytesFrom(result.screenshot, 'image/png')
    : undefined;
  const pdf = wanted.has('pdf') ? bytesFrom(result.pdf, 'application/pdf') : undefined;
  const html = wanted.has('html') ? (result.cleaned_html ?? result.html) : undefined;

  return Object.freeze({
    ...(html === undefined ? {} : { html }),
    ...(wanted.has('images') ? { images: images(result, url) } : {}),
    ...(wanted.has('markdown') ? { markdown: markdown(result) } : {}),
    ...(pdf === undefined ? {} : { pdf }),
    ...(screenshot === undefined ? {} : { screenshot }),
    ...(result.metadata?.title === undefined ? {} : { title: result.metadata.title }),
    links: links(result, url),
    url,
  });
}

function bytesFrom(value: string | undefined, mediaType: string): PageBytes | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const decoded = decodeBase64(value);
  return decoded === undefined ? undefined : Object.freeze({ bytes: decoded, mediaType });
}

function markdown(result: CrawlResult): string {
  if (typeof result.markdown === 'string') return result.markdown;
  return (
    [
      result.markdown?.fit_markdown,
      result.markdown?.raw_markdown,
      result.markdown?.markdown_with_citations,
    ].find((value) => value !== undefined && value.length > 0) ?? ''
  );
}

function images(result: CrawlResult, pageUrl: string): readonly PageImage[] {
  return Object.freeze(
    (result.media?.images ?? []).flatMap((image): PageImage[] => {
      const url = typeof image.src === 'string' ? publicUrl(image.src, pageUrl) : undefined;
      if (url === undefined) return [];
      const alt = [image.alt, image.desc].find(
        (value) => value !== undefined && value.trim().length > 0,
      );
      return [
        Object.freeze({
          ...(alt === undefined ? {} : { alt }),
          ...(image.height === undefined ? {} : { height: image.height }),
          ...(image.width === undefined ? {} : { width: image.width }),
          url,
        }),
      ];
    }),
  );
}

function links(result: CrawlResult, pageUrl: string): readonly PageLink[] {
  const all = [...(result.links?.internal ?? []), ...(result.links?.external ?? [])];
  return Object.freeze(
    all.flatMap((link): PageLink[] => {
      const url = typeof link.href === 'string' ? publicUrl(link.href, pageUrl) : undefined;
      if (url === undefined) return [];
      const text =
        link.text === undefined || link.text.trim().length === 0 ? undefined : link.text.trim();
      return [Object.freeze({ ...(text === undefined ? {} : { text }), url })];
    }),
  );
}

const crawl4aiModule: WebModule<'extract'> = Object.freeze({
  config: crawl4aiFields,
  create: (config: WebModuleConfig): ExtractCapability =>
    new Crawl4aiExtract(crawl4aiConfigSchema.parse(config)),
  id: 'crawl4ai',
});

export { crawl4aiModule };
