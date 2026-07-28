import { afterEach, describe, expect, mock, test } from 'bun:test';

import { Crawl4AIService } from './services/crawl4ai';
import { SearxngSearchService } from './services/searxng';
import { WebTools } from './webTools';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('web tools services', () => {
  test('normalizes SearXNG results and applies the configured result limit', async () => {
    const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      expect(url.pathname).toBe('/search');
      expect(url.searchParams.get('q')).toBe('nox agents');
      expect(url.searchParams.get('format')).toBe('json');
      expect(url.searchParams.get('language')).toBe('es');
      expect(init?.headers).toEqual({ Accept: 'application/json', Authorization: 'Bearer search-token' });
      return Response.json({
        results: [
          { title: 'First', url: 'https://example.com/1', content: 'One', engine: 'brave' },
          { title: 'Second', url: 'https://example.com/2', content: 'Two' },
        ],
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const service = new SearxngSearchService({
      url: 'https://search.example.com/',
      apiKey: 'search-token',
    });
    const result = await service.search({
      query: 'nox agents',
      language: 'es',
      maxResults: 1,
    }, new AbortController().signal);

    expect(result).toEqual({
      query: 'nox agents',
      results: [{
        title: 'First',
        url: 'https://example.com/1',
        snippet: 'One',
        source: 'brave',
      }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('crawls multiple URLs with a bearer token and truncates each page', async () => {
    const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input.toString()).toBe('https://crawl.example.com/crawl');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer crawl-token',
      });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        urls: ['https://example.com/article', 'https://example.com/about'],
      });
      return Response.json({
        success: true,
        results: [{
          success: true,
          url: 'https://example.com/article',
          metadata: { title: 'Article' },
          markdown: { fit_markdown: '', raw_markdown: '123456789' },
        }, {
          success: true,
          url: 'https://example.com/about',
          metadata: { title: 'About' },
          markdown: 'abcdef',
        }],
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const service = new Crawl4AIService({
      url: 'https://crawl.example.com/',
      apiKey: 'crawl-token',
    });
    const result = await service.crawl({
      urls: ['https://example.com/article', 'https://example.com/about'],
      maxCharactersPerPage: 5,
    }, new AbortController().signal);

    expect(result).toEqual({
      results: [{
        url: 'https://example.com/article',
        title: 'Article',
        content: '12345',
        truncated: true,
      }, {
        url: 'https://example.com/about',
        title: 'About',
        content: 'abcde',
        truncated: true,
      }],
    });
  });

  test('falls back to citation markdown when filtered and raw markdown are empty', async () => {
    globalThis.fetch = mock(async () => Response.json({
      success: true,
      results: [{
        success: true,
        url: 'https://example.com/cited',
        markdown: {
          fit_markdown: '',
          raw_markdown: '',
          markdown_with_citations: 'Cited page content',
        },
      }],
    })) as unknown as typeof fetch;

    const service = new Crawl4AIService({ url: 'https://crawl.example.com' });
    const result = await service.crawl({
      urls: ['https://example.com/cited'],
      maxCharactersPerPage: 100,
    }, new AbortController().signal);

    expect(result.results[0]?.content).toBe('Cited page content');
  });
});

describe('WebTools contract configuration', () => {
  test('builds tool schemas from configured limits and enabled fields', () => {
    const toolSet = new WebTools({
      web_search: {
        service: 'searxng',
        serviceConfig: { url: 'https://search.example.com' },
        contract: {
          maxResults: { default: 3, maximum: 5 },
          language: { enabled: false },
        },
      },
    });
    const search = toolSet.tools['web_search'];

    expect(search).toBeDefined();
    expect(search!.parameters.parse({ query: 'test' })).toEqual({ query: 'test', maxResults: 3 });
    expect(search!.parameters.safeParse({ query: 'test', maxResults: 6 }).success).toBe(false);
    expect('language' in search!.parameters.shape).toBe(false);
    expect(toolSet.tools['web_extract']).toBeUndefined();
  });

  test('limits the number of URLs exposed by the crawl contract', () => {
    const toolSet = new WebTools({
      web_extract: {
        service: 'crawl4ai',
        serviceConfig: { url: 'https://crawl.example.com' },
        contract: {
          maxUrls: { maximum: 2 },
          maxCharactersPerPage: { default: 1000, maximum: 2000 },
        },
      },
    });
    const extract = toolSet.tools['web_extract'];

    expect(extract!.parameters.parse({ urls: ['https://example.com'] })).toEqual({
      urls: ['https://example.com'],
      maxCharactersPerPage: 1000,
    });
    expect(extract!.parameters.safeParse({
      urls: ['https://a.example.com', 'https://b.example.com', 'https://c.example.com'],
    }).success).toBe(false);
  });
});
