import { afterEach, describe, expect, mock, test } from 'bun:test';

import { SecretHandle } from '../../../../config/secrets';
import { WebTools } from './webTools';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('WebTools', () => {
  test('exposes metadata and only configured and enabled tools', () => {
    const tools = new WebTools({
      enabledTools: ['web_search'],
      extract: { url: 'https://crawl.example.test' },
      search: { url: 'https://search.example.test' },
      type: 'web',
    });

    expect(tools.name).toBe('Web tools');
    expect(tools.description).toContain('Search');
    expect(Object.keys(tools.tools)).toEqual(['web_search']);
  });

  test('searches SearXNG and normalizes bounded results', async () => {
    const fetchMock = mock((input: Request | string | URL, init?: RequestInit) => {
      const value =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(value);
      expect(url.pathname).toBe('/search');
      expect(url.searchParams.get('q')).toBe('nox agents');
      expect(url.searchParams.get('language')).toBe('es');
      expect(init?.headers).toEqual({
        Accept: 'application/json',
        Authorization: 'Bearer secret',
      });
      return Promise.resolve(
        Response.json({
          results: [
            { content: 'One', engine: 'brave', title: 'First', url: 'https://example.test/1' },
            { content: 'Two', title: 'Second', url: 'https://example.test/2' },
          ],
        }),
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const tools = new WebTools({
      search: {
        apiKey: new SecretHandle('SEARXNG_API_KEY', 'secret'),
        defaultLanguage: 'es',
        defaultMaxResults: 1,
        maxResults: 2,
        url: 'https://search.example.test/',
      },
      type: 'web',
    });
    const execution = tools.prepare('web_search', { query: 'nox agents' });
    const content = await execution.run({ abortSignal: new AbortController().signal });

    expect(content).toEqual([
      {
        text: JSON.stringify({
          query: 'nox agents',
          results: [
            {
              snippet: 'One',
              source: 'brave',
              title: 'First',
              url: 'https://example.test/1',
            },
          ],
        }),
        type: 'text',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('extracts and truncates Crawl4AI pages', async () => {
    globalThis.fetch = mock(
      (_input: Request | string | URL, init?: RequestInit): Promise<Response> => {
        expect(init?.method).toBe('POST');
        expect(typeof init?.body).toBe('string');
        const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        expect(body).toMatchObject({ urls: ['https://example.test/article'] });
        return Promise.resolve(
          Response.json({
            results: [
              {
                markdown: { fit_markdown: '123456789' },
                metadata: { title: 'Article' },
                success: true,
                url: 'https://example.test/article',
              },
            ],
            success: true,
          }),
        );
      },
    ) as unknown as typeof fetch;

    const tools = new WebTools({
      extract: {
        defaultMaxCharactersPerPage: 5,
        maxCharactersPerPage: 10,
        maxUrls: 2,
        url: 'https://crawl.example.test/',
      },
      type: 'web',
    });
    const execution = tools.prepare('web_extract', {
      urls: ['https://example.test/article'],
    });
    const content = await execution.run({ abortSignal: new AbortController().signal });

    expect(content).toEqual([
      {
        text: JSON.stringify({
          results: [
            {
              content: '12345',
              title: 'Article',
              truncated: true,
              url: 'https://example.test/article',
            },
          ],
        }),
        type: 'text',
      },
    ]);
  });

  test('rejects empty service configuration and inconsistent limits', () => {
    expect(WebTools.configSchema.safeParse({ type: 'web' }).success).toBe(false);
    expect(
      WebTools.configSchema.safeParse({
        search: {
          defaultMaxResults: 10,
          maxResults: 5,
          url: 'https://search.example.test',
        },
        type: 'web',
      }).success,
    ).toBe(false);
  });
});
