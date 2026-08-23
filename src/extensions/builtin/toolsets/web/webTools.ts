import { z } from 'zod';

import { SecretHandle, secretRefSchema } from '../../../../config/secrets';
import { httpUrlSchema } from '../../../../config/url';
import { type Tool, ToolSet } from '../../../../tool/tool';
import { stableStringify } from '../../../../utils/json';
import { toolSetBaseConfigSchema } from '../../../contribution-points/toolsets';

import type { MessageContent } from '../../../../agent/context/message';

/**
 * This extension's own authorities. They sit under its extension ID, which is
 * what the catalog checks: nothing here can claim a name belonging to the core
 * or to another extension.
 */
const WEB_SEARCH_AUTHORITY = 'nox.toolset.web.search';
const WEB_EXTRACT_AUTHORITY = 'nox.toolset.web.extract';
const WEB_VIEW_IMAGE_AUTHORITY = 'nox.toolset.web.view-image';

/**
 * One shape, built twice over what fills `apiKey`: a reference in the stored
 * form, an opaque handle in the runtime form the factory receives.
 *
 * Per endpoint, because search and extract are separate services that happen to
 * be bundled in one tool set — one credential for both would have an operator
 * send a SearXNG token to Crawl4AI.
 */
function createWebToolsConfigSchema<TApiKey extends z.ZodType>(apiKey: TApiKey) {
  const endpoint = z.object({
    apiKey: apiKey.optional(),
    timeoutMs: z.number().int().positive().optional(),
    url: httpUrlSchema('The HTTP(S) base URL of the backing service.'),
  });
  const search = endpoint.extend({
    defaultLanguage: z.string().min(1).default('all'),
    defaultMaxResults: z.number().int().positive().default(8),
    maxResults: z.number().int().positive().default(20),
  });
  const extract = endpoint.extend({
    defaultMaxCharactersPerPage: z.number().int().positive().default(30_000),
    maxCharactersPerPage: z.number().int().positive().default(100_000),
    maxUrls: z.number().int().positive().default(5),
  });

  return toolSetBaseConfigSchema
    .extend({
      extract: extract.optional(),
      search: search.optional(),
      type: z.literal('web'),
    })
    .superRefine((config, context) => {
      if (config.search === undefined && config.extract === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Configure at least one of search or extract.',
        });
      }
      if (
        config.search !== undefined &&
        config.search.defaultMaxResults > config.search.maxResults
      ) {
        context.addIssue({
          code: 'custom',
          message: 'defaultMaxResults cannot exceed maxResults.',
          path: ['search', 'defaultMaxResults'],
        });
      }
      if (
        config.extract !== undefined &&
        config.extract.defaultMaxCharactersPerPage > config.extract.maxCharactersPerPage
      ) {
        context.addIssue({
          code: 'custom',
          message: 'defaultMaxCharactersPerPage cannot exceed maxCharactersPerPage.',
          path: ['extract', 'defaultMaxCharactersPerPage'],
        });
      }
    });
}

const webToolsConfigSchema = createWebToolsConfigSchema(secretRefSchema);
const webToolsRuntimeConfigSchema = createWebToolsConfigSchema(z.instanceof(SecretHandle));

type WebToolsConfig = z.infer<typeof webToolsConfigSchema>;
type WebToolsConfigInput = z.input<typeof webToolsConfigSchema>;
type WebToolsRuntimeConfig = z.infer<typeof webToolsRuntimeConfigSchema>;
type WebToolsRuntimeConfigInput = z.input<typeof webToolsRuntimeConfigSchema>;
type SearchConfig = NonNullable<WebToolsRuntimeConfig['search']>;
type ExtractConfig = NonNullable<WebToolsRuntimeConfig['extract']>;

interface SearxngResult {
  content?: string;
  engine?: string;
  engines?: string[];
  publishedDate?: string;
  title?: string;
  url?: string;
}

interface CrawlImage {
  alt?: string;
  desc?: string;
  score?: number;
  src?: string;
  type?: string;
}

interface CrawlResult {
  error_message?: string;
  markdown?:
    | string
    | {
        fit_markdown?: string;
        markdown_with_citations?: string;
        raw_markdown?: string;
      };
  media?: { images?: CrawlImage[] };
  metadata?: { title?: string };
  success?: boolean;
  url?: string;
}

function text(value: unknown): MessageContent[] {
  return [{ text: stableStringify(value), type: 'text' }];
}

function baseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function requestSignal(parent: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
}

function headersFor(apiKey: SecretHandle | undefined, contentType = false): Record<string, string> {
  return {
    Accept: 'application/json',
    ...(contentType ? { 'Content-Type': 'application/json' } : {}),
    ...(apiKey === undefined ? {} : { Authorization: `Bearer ${apiKey.reveal()}` }),
  };
}

async function responseError(response: Response): Promise<Error> {
  const detail = (await response.text().catch(() => '')).trim().slice(0, 500);
  return new Error(
    `Web service returned HTTP ${String(response.status)}${detail.length > 0 ? `: ${detail}` : '.'}`,
  );
}

function crawlResults(body: unknown): CrawlResult[] {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Crawl4AI returned an invalid response.');
  }

  const response = body as {
    result?: CrawlResult;
    results?: CrawlResult[];
    success?: boolean;
  };
  if (response.success === false) {
    throw new Error('Crawl4AI could not crawl the requested page.');
  }
  return response.results ?? (response.result === undefined ? [body] : [response.result]);
}

function markdownFrom(result: CrawlResult): string {
  if (typeof result.markdown === 'string') return result.markdown;
  return (
    [
      result.markdown?.fit_markdown,
      result.markdown?.raw_markdown,
      result.markdown?.markdown_with_citations,
    ].find((value) => value !== undefined && value.length > 0) ?? ''
  );
}

function resolvedPublicUrl(value: string, pageUrl: string): string | undefined {
  try {
    const url = new URL(value, pageUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    if (url.username.length > 0 || url.password.length > 0) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function imagesFrom(result: CrawlResult, pageUrl: string, limit: number) {
  return (result.media?.images ?? [])
    .flatMap((image) => {
      const url = typeof image.src === 'string' ? resolvedPublicUrl(image.src, pageUrl) : undefined;
      if (url === undefined) return [];
      return [
        {
          ...(typeof image.alt === 'string' && image.alt.length > 0 ? { alt: image.alt } : {}),
          ...(typeof image.desc === 'string' && image.desc.length > 0
            ? { description: image.desc }
            : {}),
          ...(typeof image.score === 'number' && Number.isFinite(image.score)
            ? { score: image.score }
            : {}),
          ...(typeof image.type === 'string' && image.type.length > 0 ? { kind: image.type } : {}),
          url,
        },
      ];
    })
    .slice(0, limit);
}

/** Web search and page extraction backed by configured SearXNG and Crawl4AI services. */
class WebTools extends ToolSet {
  static readonly configSchema = webToolsConfigSchema;

  readonly #config: WebToolsRuntimeConfig;

  constructor(input: WebToolsRuntimeConfigInput) {
    const config = webToolsRuntimeConfigSchema.parse(input);
    super(
      'Web tools',
      'Search the public web and extract readable content from web pages.',
      config.enabledTools,
    );
    this.#config = config;
    this.addTools();
  }

  protected override addTools(): void {
    if (this.#config.search !== undefined) this.registerTool(this.#searchTool(this.#config.search));
    if (this.#config.extract !== undefined) {
      this.registerTool(this.#extractTool(this.#config.extract));
    }
    this.registerTool(this.#viewImageTool());
  }

  #searchTool(config: SearchConfig): Tool {
    const parameters = z.object({
      language: z
        .string()
        .min(1)
        .default(config.defaultLanguage)
        .describe('SearXNG language code, such as en, es, or all.'),
      maxResults: z
        .number()
        .int()
        .positive()
        .max(config.maxResults)
        .default(config.defaultMaxResults)
        .describe('Maximum number of search results to return.'),
      query: z.string().trim().min(1).describe('The public web search query.'),
    });

    const tool: Tool<typeof parameters> = {
      authority: WEB_SEARCH_AUTHORITY,
      description: 'Search the public web and return result titles, URLs, and snippets.',
      name: 'web_search',
      parameters,
      prepare: ({ language, maxResults, query }) => ({
        risk: {
          effects: ['network', 'read'],
          resources: [{ kind: 'url', value: config.url }],
          reversible: true,
        },
        run: async ({ abortSignal }) => {
          const url = new URL(`${baseUrl(config.url)}/search`);
          url.searchParams.set('q', query);
          url.searchParams.set('format', 'json');
          url.searchParams.set('language', language);

          const response = await fetch(url, {
            headers: headersFor(config.apiKey),
            signal: requestSignal(abortSignal, config.timeoutMs ?? 30_000),
          });
          if (!response.ok) throw await responseError(response);

          const body = (await response.json()) as { results?: SearxngResult[] };
          const results = (body.results ?? [])
            .filter(
              (result): result is SearxngResult & { title: string; url: string } =>
                typeof result.title === 'string' && typeof result.url === 'string',
            )
            .slice(0, maxResults)
            .map((result) => {
              const source = result.engine ?? result.engines?.[0];
              return {
                ...(source === undefined ? {} : { source }),
                ...(result.publishedDate === undefined
                  ? {}
                  : { publishedAt: result.publishedDate }),
                snippet: result.content ?? '',
                title: result.title,
                url: result.url,
              };
            });

          return text({ query, results });
        },
        title: `Search web — ${query}`,
        type: 'immediate',
      }),
      risk: { effects: ['network', 'read'], reversible: true },
    };
    return tool;
  }

  #extractTool(config: ExtractConfig): Tool {
    const parameters = z.object({
      maxCharactersPerPage: z
        .number()
        .int()
        .positive()
        .max(config.maxCharactersPerPage)
        .default(config.defaultMaxCharactersPerPage)
        .describe('Maximum number of Markdown characters to return for each page.'),
      maxImagesPerPage: z
        .number()
        .int()
        .nonnegative()
        .max(50)
        .default(12)
        .describe('Maximum discovered image URLs to return for each page.'),
      urls: z
        .array(httpUrlSchema('A public page URL to crawl.'))
        .min(1)
        .max(config.maxUrls)
        .describe('The page URLs to crawl in one batch.'),
    });

    const tool: Tool<typeof parameters> = {
      authority: WEB_EXTRACT_AUTHORITY,
      description: 'Extract web pages and return separate Markdown results for each URL.',
      name: 'web_extract',
      parameters,
      prepare: ({ maxCharactersPerPage, maxImagesPerPage, urls }) => ({
        risk: {
          effects: ['network', 'read'],
          resources: urls.map((url) => ({ kind: 'url' as const, value: url })),
          reversible: true,
          volume: urls.length,
        },
        run: async ({ abortSignal }) => {
          const response = await fetch(`${baseUrl(config.url)}/crawl`, {
            body: JSON.stringify({
              browser_config: { params: { headless: true }, type: 'BrowserConfig' },
              crawler_config: { params: { stream: false }, type: 'CrawlerRunConfig' },
              urls,
            }),
            headers: headersFor(config.apiKey, true),
            method: 'POST',
            signal: requestSignal(abortSignal, config.timeoutMs ?? 120_000),
          });
          if (!response.ok) throw await responseError(response);

          const crawled = crawlResults(await response.json());
          return text({
            results: crawled.map((result, index) => {
              const completeContent = markdownFrom(result);
              const pageUrl = result.url ?? urls[index] ?? '';
              const images = imagesFrom(result, pageUrl, maxImagesPerPage);
              return {
                content: completeContent.slice(0, maxCharactersPerPage),
                ...(result.success === false
                  ? { error: result.error_message ?? 'Crawl4AI could not crawl this page.' }
                  : {}),
                ...(images.length === 0 ? {} : { images }),
                ...(result.metadata?.title === undefined ? {} : { title: result.metadata.title }),
                truncated: completeContent.length > maxCharactersPerPage,
                url: pageUrl,
              };
            }),
          });
        },
        title: `Extract ${String(urls.length)} web page${urls.length === 1 ? '' : 's'}`,
        type: 'immediate',
      }),
      risk: { effects: ['network', 'read'], reversible: true },
    };
    return tool;
  }

  #viewImageTool(): Tool {
    const parameters = z.object({
      caption: z
        .string()
        .trim()
        .max(500)
        .optional()
        .describe('Optional provenance or reason this image was selected.'),
      url: httpUrlSchema('A public image URL for the multimodal model to inspect.'),
    });

    const tool: Tool<typeof parameters> = {
      authority: WEB_VIEW_IMAGE_AUTHORITY,
      description:
        'Present one public image URL as visual content to a multimodal model. ' +
        'Use an image URL discovered by web_extract or web_search.',
      name: 'web_view_image',
      parameters,
      prepare: ({ caption, url }) => ({
        risk: {
          effects: ['network', 'read'],
          resources: [{ kind: 'url', value: url }],
          reversible: true,
        },
        run: () =>
          Promise.resolve([
            {
              text: stableStringify({
                ...(caption === undefined || caption.length === 0 ? {} : { caption }),
                url,
              }),
              type: 'text' as const,
            },
            { source: { type: 'url' as const, url }, type: 'image' as const },
          ]),
        title: `View image — ${new URL(url).hostname}`,
        type: 'immediate',
      }),
      risk: { effects: ['network', 'read'], reversible: true },
    };
    return tool;
  }
}

export {
  WEB_EXTRACT_AUTHORITY,
  WEB_SEARCH_AUTHORITY,
  WEB_VIEW_IMAGE_AUTHORITY,
  WebTools,
  webToolsConfigSchema,
};

export type { WebToolsConfig, WebToolsConfigInput };
