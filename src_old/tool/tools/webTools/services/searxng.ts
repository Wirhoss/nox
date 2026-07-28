import { z } from 'zod';

import { normalizedBaseUrl, responseError, signalWithTimeout, webServiceLogger } from './shared';

import type { WebSearchResponse, WebSearchService, WebSearchServiceDefinition } from '../types';

const searxngServiceConfigSchema = z.object({
  url: z.url(),
  apiKey: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const webSearchContractSchema = z.object({
  maxResults: z.object({
    default: z.number().int().positive(),
    maximum: z.number().int().positive(),
  }).refine(value => value.default <= value.maximum, {
    message: 'The default result count cannot exceed its maximum.',
  }),
  language: z.object({
    enabled: z.boolean(),
    default: z.string().min(1).optional(),
  }),
});

type SearxngConfig = z.infer<typeof searxngServiceConfigSchema>;

type SearxngResult = {
  content?: string;
  engine?: string;
  engines?: string[];
  parsed_url?: string[];
  publishedDate?: string;
  title?: string;
  url?: string;
};

class SearxngSearchService implements WebSearchService {
  constructor(private readonly config: SearxngConfig) {}

  public async search(input: {
    language?: string;
    maxResults: number;
    query: string;
  }, signal: AbortSignal): Promise<WebSearchResponse> {
    const url = new URL(`${normalizedBaseUrl(this.config.url)}/search`);
    url.searchParams.set('q', input.query);
    url.searchParams.set('format', 'json');
    if (input.language) {
      url.searchParams.set('language', input.language);
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    const startedAt = Date.now();
    const response = await fetch(url, {
      headers,
      signal: signalWithTimeout(signal, this.config.timeoutMs ?? 30_000),
    });
    if (!response.ok) {
      throw await responseError(response);
    }
    const body = await response.json() as { results?: SearxngResult[] };
    // A search that returns nothing is a common, silent dead end for an agent.
    webServiceLogger.debug(
      {
        durationMs: Date.now() - startedAt,
        maxResults: input.maxResults,
        resultCount: body.results?.length ?? 0,
        service: 'searxng',
      },
      'Web search completed.',
    );
    const results = (body.results ?? [])
      .filter(result => typeof result.url === 'string' && typeof result.title === 'string')
      .slice(0, input.maxResults)
      .map(result => ({
        title: result.title!,
        url: result.url!,
        snippet: result.content ?? '',
        ...(result.engine ?? result.engines?.[0]
          ? { source: result.engine ?? result.engines?.[0] }
          : {}),
        ...(result.publishedDate ? { publishedAt: result.publishedDate } : {}),
      }));
    return { query: input.query, results };
  }
}

const searxngDefinition: WebSearchServiceDefinition<
  typeof searxngServiceConfigSchema,
  typeof webSearchContractSchema
> = {
  id: 'searxng',
  label: 'SearXNG',
  serviceConfigSchema: searxngServiceConfigSchema,
  contractConfigSchema: webSearchContractSchema,
  serviceFields: [
    { name: 'url', label: 'URL', type: 'url', required: true, help: 'Base URL of the SearXNG instance.' },
    { name: 'apiKey', label: 'API key', type: 'text', secret: true, help: 'Optional bearer token used by a protected instance.' },
    { name: 'timeoutMs', label: 'Timeout', type: 'number', minimum: 1, defaultValue: 30000, help: 'Request timeout in milliseconds.' },
  ],
  contractFields: [
    { name: 'maxResults.default', label: 'Default results', type: 'number', minimum: 1, defaultValue: 8, required: true },
    { name: 'maxResults.maximum', label: 'Maximum results', type: 'number', minimum: 1, defaultValue: 20, required: true },
    { name: 'language.enabled', label: 'Expose language', type: 'boolean', defaultValue: true, required: true },
    { name: 'language.default', label: 'Default language', type: 'text', defaultValue: 'all', help: 'SearXNG language code, for example en or all.' },
  ],
  create: config => new SearxngSearchService(config),
};

export {
  searxngDefinition,
  searxngServiceConfigSchema,
  SearxngSearchService,
  webSearchContractSchema,
};
