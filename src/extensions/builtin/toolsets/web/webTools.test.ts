import { afterEach, describe, expect, mock, test } from 'bun:test';

import { SecretHandle } from '../../../../config/secrets';
import { WebTools } from './webTools';

import type { ArtifactOutputInput, ArtifactOutputPublisher } from '../../../../artifact/output';

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
                media: {
                  images: [
                    { alt: 'Diagram', score: 8.5, src: '/diagram.png', type: 'image' },
                    { src: 'data:image/png;base64,private' },
                  ],
                },
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
              images: [
                {
                  alt: 'Diagram',
                  kind: 'image',
                  score: 8.5,
                  url: 'https://example.test/diagram.png',
                },
              ],
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

  test('publishes bounded Markdown as a durable artifact without echoing its bytes', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        Response.json({
          results: [
            {
              markdown: 'artifact body',
              metadata: { title: 'Artifact: Article' },
              success: true,
              url: 'https://example.test/article',
            },
          ],
          success: true,
        }),
      ),
    ) as unknown as typeof fetch;

    let published: ArtifactOutputInput | undefined;
    const artifacts: ArtifactOutputPublisher = {
      publish: (input) => {
        published = input;
        if (!(input.data instanceof Blob)) throw new Error('Expected a Blob.');
        return Promise.resolve({
          artifact: {
            artifactId: 'art_webpage1',
            filename: input.filename,
            mediaType: 'text/markdown',
            size: input.data.size,
          },
          type: 'artifact',
        });
      },
    };
    const tools = new WebTools({
      extract: { url: 'https://crawl.example.test/' },
      type: 'web',
    });
    const execution = tools.prepare('web_extract', {
      returnArtifacts: true,
      urls: ['https://example.test/article'],
    });
    const content = await execution.run({
      abortSignal: new AbortController().signal,
      artifacts,
    });

    expect(execution.risk).toMatchObject({
      effects: ['network', 'read', 'write'],
      reversible: false,
    });
    expect(tools.tools.web_extract?.output).toEqual({ artifacts: true });
    expect(published).toMatchObject({
      declaredMediaType: 'text/markdown',
      filename: 'Artifact- Article.md',
    });
    if (!(published?.data instanceof Blob)) throw new Error('Markdown was not published.');
    expect(await published.data.text()).toBe('artifact body');
    expect(content).toEqual([
      {
        text: JSON.stringify({
          results: [
            {
              artifactId: 'art_webpage1',
              title: 'Artifact: Article',
              truncated: false,
              url: 'https://example.test/article',
            },
          ],
        }),
        type: 'text',
      },
      {
        artifact: {
          artifactId: 'art_webpage1',
          filename: 'Artifact- Article.md',
          mediaType: 'text/markdown',
          size: 13,
        },
        type: 'artifact',
      },
    ]);
    expect(JSON.stringify(content)).not.toContain('artifact body');
  });

  test('returns an image as model-visible content instead of a textual URL', async () => {
    const tools = new WebTools({
      search: { url: 'https://search.example.test' },
      type: 'web',
    });
    const execution = tools.prepare('web_view_image', {
      caption: 'Official product photo',
      url: 'https://images.example.test/product.webp',
    });

    const content = await execution.run({ abortSignal: new AbortController().signal });

    expect(content).toEqual([
      {
        text: JSON.stringify({
          caption: 'Official product photo',
          url: 'https://images.example.test/product.webp',
        }),
        type: 'text',
      },
      {
        source: { type: 'url', url: 'https://images.example.test/product.webp' },
        type: 'image',
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
