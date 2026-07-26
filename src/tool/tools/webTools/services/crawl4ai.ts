import { z } from 'zod';

import { normalizedBaseUrl, responseError, signalWithTimeout, webServiceLogger } from './shared';

import type { WebExtractResponse, WebExtractService, WebExtractServiceDefinition } from '../types';

const crawl4aiServiceConfigSchema = z.object({
  url: z.url(),
  apiKey: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const webExtractContractSchema = z.object({
  maxUrls: z.object({
    maximum: z.number().int().positive(),
  }),
  maxCharactersPerPage: z.object({
    default: z.number().int().positive(),
    maximum: z.number().int().positive(),
  }).refine(value => value.default <= value.maximum, {
    message: 'The default character count cannot exceed its maximum.',
  }),
});

type Crawl4AIConfig = z.infer<typeof crawl4aiServiceConfigSchema>;

type Crawl4AIResult = {
  markdown?: string | {
    fit_markdown?: string;
    markdown_with_citations?: string;
    raw_markdown?: string;
  };
  metadata?: { title?: string };
  error_message?: string;
  success?: boolean;
  url?: string;
};

function crawlResults(body: unknown): Crawl4AIResult[] {
  if (!body || typeof body !== 'object') {
    throw new Error('Crawl4AI returned an invalid response.');
  }
  const value = body as {
    result?: Crawl4AIResult;
    results?: Crawl4AIResult[];
    success?: boolean;
  };
  if (value.success === false) {
    throw new Error('Crawl4AI could not crawl the requested page.');
  }
  return value.results ?? (value.result ? [value.result] : [body as Crawl4AIResult]);
}

function markdownFrom(result: Crawl4AIResult): string {
  if (typeof result.markdown === 'string') {
    return result.markdown;
  }
  return result.markdown?.fit_markdown
    || result.markdown?.raw_markdown
    || result.markdown?.markdown_with_citations
    || '';
}

class Crawl4AIService implements WebExtractService {
  constructor(private readonly config: Crawl4AIConfig) {}

  public async crawl(input: {
    maxCharactersPerPage: number;
    urls: string[];
  }, signal: AbortSignal): Promise<WebExtractResponse> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    const startedAt = Date.now();
    const response = await fetch(`${normalizedBaseUrl(this.config.url)}/crawl`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        urls: input.urls,
        browser_config: {
          type: 'BrowserConfig',
          params: { headless: true },
        },
        crawler_config: {
          type: 'CrawlerRunConfig',
          params: { stream: false },
        },
      }),
      signal: signalWithTimeout(signal, this.config.timeoutMs ?? 120_000),
    });
    if (!response.ok) {
      throw await responseError(response);
    }
    const crawled = crawlResults(await response.json());
    // Per-page failures come back inside a 200, so they are only visible here.
    const failedCount = crawled.filter((result) => result.success === false).length;
    webServiceLogger.debug(
      {
        durationMs: Date.now() - startedAt,
        failedCount,
        requestedCount: input.urls.length,
        resultCount: crawled.length,
        service: 'crawl4ai',
      },
      'Web crawl completed.',
    );
    if (failedCount > 0) {
      webServiceLogger.warn(
        { failedCount, requestedCount: input.urls.length, service: 'crawl4ai' },
        'Web crawl could not fetch some pages.',
      );
    }
    return {
      results: crawled.map((result, index) => {
        const completeContent = markdownFrom(result);
        return {
          url: result.url ?? input.urls[index] ?? '',
          ...(result.metadata?.title ? { title: result.metadata.title } : {}),
          content: completeContent.slice(0, input.maxCharactersPerPage),
          truncated: completeContent.length > input.maxCharactersPerPage,
          ...(result.success === false
            ? { error: result.error_message ?? 'Crawl4AI could not crawl this page.' }
            : {}),
        };
      }),
    };
  }
}

const crawl4aiDefinition: WebExtractServiceDefinition<
  typeof crawl4aiServiceConfigSchema,
  typeof webExtractContractSchema
> = {
  id: 'crawl4ai',
  label: 'Crawl4AI',
  serviceConfigSchema: crawl4aiServiceConfigSchema,
  contractConfigSchema: webExtractContractSchema,
  serviceFields: [
    { name: 'url', label: 'URL', type: 'url', required: true, help: 'Base URL of the Crawl4AI server.' },
    { name: 'apiKey', label: 'API key', type: 'text', secret: true, help: 'Bearer token used by Crawl4AI.' },
    { name: 'timeoutMs', label: 'Timeout', type: 'number', minimum: 1, defaultValue: 120000, help: 'Request timeout in milliseconds.' },
  ],
  contractFields: [
    { name: 'maxUrls.maximum', label: 'Maximum URLs per call', type: 'number', minimum: 1, defaultValue: 5, required: true },
    { name: 'maxCharactersPerPage.default', label: 'Default characters per page', type: 'number', minimum: 1, defaultValue: 30000, required: true },
    { name: 'maxCharactersPerPage.maximum', label: 'Maximum characters per page', type: 'number', minimum: 1, defaultValue: 100000, required: true },
  ],
  create: config => new Crawl4AIService(config),
};

export {
  crawl4aiDefinition,
  crawl4aiServiceConfigSchema,
  Crawl4AIService,
  webExtractContractSchema,
};
