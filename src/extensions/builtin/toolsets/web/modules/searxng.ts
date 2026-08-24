import { z } from 'zod';

import { WebService } from '../http';
import {
  endpointFields,
  runtimeCredentialSchema,
  type WebModule,
  type WebModuleConfig,
} from '../module';

import type {
  SearchCapability,
  SearchRequest,
  SearchResult,
  WebRequestContext,
} from '../capabilities';

/**
 * SearXNG: a self-hosted metasearch front end queried through its JSON format.
 *
 * It is the first search module and deliberately not the shape of the slot. Its
 * engine list, its language codes and its `/search` route are its own; a hosted
 * search API added beside it declares an API key and nothing else, and neither
 * has to grow a field for the other's sake.
 */
function searxngFields<TCredential extends z.ZodType>(credential: TCredential) {
  return {
    ...endpointFields(credential, {
      timeoutMs: 30_000,
      url: 'The base URL of the SearXNG instance. Nox appends /search.',
    }),
    defaultLanguage: z
      .string()
      .min(1)
      .default('all')
      .meta({ nox: { help: 'ui.searxng.languageHelp', label: 'ui.searxng.language' } }),
    defaultMaxResults: z
      .number()
      .int()
      .positive()
      .default(8)
      .meta({ nox: { label: 'ui.defaultResults' } }),
    engines: z
      .string()
      .trim()
      .min(1)
      .optional()
      .meta({ nox: { help: 'ui.searxng.enginesHelp', label: 'ui.searxng.engines' } }),
    maxResults: z
      .number()
      .int()
      .positive()
      .max(100)
      .default(20)
      .meta({ nox: { label: 'ui.maximumResults' } }),
    safeSearch: z
      .union([z.literal(0), z.literal(1), z.literal(2)])
      .default(1)
      .meta({ nox: { help: 'ui.searxng.safeSearchHelp', label: 'ui.searxng.safeSearch' } }),
  };
}

const searxngConfigSchema = z.object(searxngFields(runtimeCredentialSchema));

type SearxngConfig = z.infer<typeof searxngConfigSchema>;

interface SearxngResult {
  content?: string;
  engine?: string;
  engines?: string[];
  publishedDate?: string;
  title?: string;
  url?: string;
}

class SearxngSearch implements SearchCapability {
  /** SearXNG narrows by language, so the tool may ask the model for one. */
  public readonly languages = true;

  readonly #config: SearxngConfig;
  readonly #service: WebService;

  constructor(config: SearxngConfig) {
    this.#config = config;
    this.#service = new WebService('SearXNG', config);
  }

  public get defaultLanguage(): string {
    return this.#config.defaultLanguage;
  }

  public get defaultMaxResults(): number {
    return Math.min(this.#config.defaultMaxResults, this.#config.maxResults);
  }

  public get origin(): string {
    return this.#service.origin;
  }

  public get maxResults(): number {
    return this.#config.maxResults;
  }

  public async search(
    request: SearchRequest,
    context: WebRequestContext,
  ): Promise<readonly SearchResult[]> {
    const body = await this.#service.json<{ results?: SearxngResult[] }>('/search', {
      query: {
        engines: this.#config.engines,
        format: 'json',
        language: request.language ?? this.#config.defaultLanguage,
        q: request.query,
        safesearch: this.#config.safeSearch,
      },
      signal: context.signal,
    });

    return Object.freeze(
      (body.results ?? [])
        .filter(
          (result): result is SearxngResult & { title: string; url: string } =>
            typeof result.title === 'string' && typeof result.url === 'string',
        )
        .slice(0, request.maxResults)
        .map((result) => {
          const source = result.engine ?? result.engines?.[0];
          return Object.freeze({
            ...(result.publishedDate === undefined ? {} : { publishedAt: result.publishedDate }),
            ...(result.content === undefined ? {} : { snippet: result.content }),
            ...(source === undefined ? {} : { source }),
            title: result.title,
            url: result.url,
          });
        }),
    );
  }
}

const searxngModule: WebModule<'search'> = Object.freeze({
  config: searxngFields,
  create: (config: WebModuleConfig): SearchCapability =>
    new SearxngSearch(searxngConfigSchema.parse(config)),
  id: 'searxng',
});

export { searxngModule };
