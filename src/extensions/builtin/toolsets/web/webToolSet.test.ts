import { afterEach, describe, expect, mock, test } from 'bun:test';

import { SecretHandle } from '../../../../config/secrets';
import { WebToolSet } from './webToolSet';

import type { MessageContent } from '../../../../agent/context/message';
import type { ArtifactOutputInput, ArtifactOutputPublisher } from '../../../../artifact/output';
import type { ContentArtifact } from '../../../../content/content';
import type { ToolContext, ToolExecution } from '../../../../tool/tool';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Records what a tool published, since that is most of what these tools produce. */
function recordingPublisher(): {
  publisher: ArtifactOutputPublisher;
  published: ArtifactOutputInput[];
} {
  const published: ArtifactOutputInput[] = [];
  const publisher: ArtifactOutputPublisher = {
    publish: (input): Promise<ContentArtifact> => {
      published.push(input);
      const size = input.data instanceof Blob ? input.data.size : 0;
      return Promise.resolve({
        artifact: {
          artifactId: `art_${String(published.length).padStart(8, '0')}`,
          ...(input.filename === undefined ? {} : { filename: input.filename }),
          mediaType: input.declaredMediaType ?? 'application/octet-stream',
          size,
        },
        type: 'artifact',
      });
    },
  };
  return { published, publisher };
}

function context(artifacts?: ArtifactOutputPublisher) {
  return {
    abortSignal: new AbortController().signal,
    ...(artifacts === undefined ? {} : { artifacts }),
  };
}

/** Runs a prepared call whichever way it answers, and reads its text part. */
async function ran(execution: ToolExecution, ctx: ToolContext): Promise<MessageContent[]> {
  const output = await execution.run(ctx);
  return Array.isArray(output) ? output : await output.result;
}

function parsed(content: readonly MessageContent[]): Record<string, unknown> {
  const first = content[0];
  if (first?.type !== 'text') throw new Error('The tool answered without text.');
  return JSON.parse(first.text) as Record<string, unknown>;
}

describe('WebToolSet configuration', () => {
  test('refuses an instance with no slot filled', () => {
    expect(() => new WebToolSet({ type: 'web' })).toThrow();
  });

  test('refuses a module nothing registered', () => {
    expect(
      () =>
        new WebToolSet({
          search: { module: 'firecrawl', url: 'https://search.example.test' },
          type: 'web',
        } as never),
    ).toThrow();
  });

  test('exposes one tool per filled slot, cut down by enabledTools', () => {
    const all = new WebToolSet({
      browser: { module: 'camoufox', url: 'https://browser.example.test' },
      extract: { module: 'crawl4ai', url: 'https://crawl.example.test' },
      search: { module: 'searxng', url: 'https://search.example.test' },
      type: 'web',
    });
    // One browser tool per action the module declares, beside the two others.
    expect(Object.keys(all.tools)).toEqual([
      'browser_click',
      'browser_close',
      'browser_images',
      'browser_links',
      'browser_navigate',
      'browser_open',
      'browser_press',
      'browser_screenshot',
      'browser_scroll',
      'browser_snapshot',
      'browser_type',
      'browser_wait',
      'web_extract',
      'web_search',
    ]);
    expect(all.description).toContain('search the public web'.slice(1));

    const searchOnly = new WebToolSet({
      search: { module: 'searxng', url: 'https://search.example.test' },
      type: 'web',
    });
    expect(Object.keys(searchOnly.tools)).toEqual(['web_search']);

    const cut = new WebToolSet({
      enabledTools: ['web_search'],
      extract: { module: 'crawl4ai', url: 'https://crawl.example.test' },
      search: { module: 'searxng', url: 'https://search.example.test' },
      type: 'web',
    });
    expect(Object.keys(cut.tools)).toEqual(['web_search']);
  });
});

describe('web_search over the searxng module', () => {
  test('queries the instance and normalizes bounded results', async () => {
    const fetchMock = mock((input: Request | string | URL, init?: RequestInit) => {
      const value =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(value);
      expect(url.pathname).toBe('/search');
      expect(url.searchParams.get('q')).toBe('nox agents');
      expect(url.searchParams.get('language')).toBe('es');
      expect(url.searchParams.get('safesearch')).toBe('1');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret');
      return Promise.resolve(
        Response.json({
          results: [
            { content: 'One', engine: 'brave', title: 'First', url: 'https://example.test/1' },
            { content: 'Two', title: 'Second', url: 'https://example.test/2' },
            { title: 'Third', url: 'https://example.test/3' },
          ],
        }),
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const tools = new WebToolSet({
      search: {
        apiKey: new SecretHandle('SEARXNG_API_KEY', 'secret'),
        defaultLanguage: 'es',
        defaultMaxResults: 2,
        module: 'searxng',
        url: 'https://search.example.test/',
      },
      type: 'web',
    });

    const body = parsed(await ran(tools.prepare('web_search', { query: 'nox agents' }), context()));

    expect(body.results).toEqual([
      { snippet: 'One', source: 'brave', title: 'First', url: 'https://example.test/1' },
      { snippet: 'Two', title: 'Second', url: 'https://example.test/2' },
    ]);
  });

  test('refuses more results than the module was configured to allow', () => {
    const tools = new WebToolSet({
      search: { maxResults: 5, module: 'searxng', url: 'https://search.example.test' },
      type: 'web',
    });
    expect(() => tools.prepare('web_search', { maxResults: 50, query: 'x' })).toThrow();
  });
});

describe('web_extract over the crawl4ai module', () => {
  const crawled = {
    results: [
      {
        cleaned_html: '<article><h1>Nox</h1><p>Agents</p></article>',
        media: { images: [{ alt: 'Diagram', src: '/diagram.png' }] },
        metadata: { title: 'Nox' },
        success: true,
        url: 'https://example.test/nox',
      },
    ],
  };

  test('publishes the page and its images as artifacts and reports them', async () => {
    const fetchMock = mock((input: Request | string | URL) => {
      const value =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (value.includes('/crawl')) return Promise.resolve(Response.json(crawled));
      expect(value).toBe('https://example.test/diagram.png');
      return Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { published, publisher } = recordingPublisher();
    const tools = new WebToolSet({
      extract: { module: 'crawl4ai', url: 'https://crawl.example.test' },
      type: 'web',
    });

    const content = await ran(
      tools.prepare('web_extract', { urls: ['https://example.test/nox'] }),
      context(publisher),
    );

    expect(published.map((input) => input.declaredMediaType)).toEqual(['text/html', 'image/png']);
    expect(published[0]?.filename).toBe('Nox.html');
    expect(published[1]?.filename).toBe('Diagram.png');

    const report = parsed(content);
    const pages = report.pages as {
      artifacts: Record<string, string>;
      excerpt: string;
      images: { alt?: string; artifactId: string; url: string }[];
    }[];
    expect(pages[0]?.artifacts.html).toBe('art_00000001');
    expect(pages[0]?.excerpt).toContain('Nox Agents');
    expect(pages[0]?.images[0]).toEqual({
      alt: 'Diagram',
      artifactId: 'art_00000002',
      url: 'https://example.test/diagram.png',
    });
    // Every published file is also referenced in the transcript.
    expect(content.filter((part: MessageContent) => part.type === 'artifact')).toHaveLength(2);
  });

  test('keeps a failed page as a result instead of losing the batch', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        Response.json({
          results: [
            { error_message: 'timed out', success: false, url: 'https://dead.example.test' },
            { ...crawled.results[0] },
          ],
        }),
      ),
    ) as unknown as typeof fetch;

    const { publisher } = recordingPublisher();
    const tools = new WebToolSet({
      extract: { module: 'crawl4ai', url: 'https://crawl.example.test' },
      type: 'web',
    });

    const content = await ran(
      tools.prepare('web_extract', {
        capture: ['html'],
        urls: ['https://dead.example.test', 'https://example.test/nox'],
      }),
      context(publisher),
    );

    const pages = parsed(content).pages as {
      error?: string;
      url: string;
    }[];
    expect(pages[0]?.error).toBe('timed out');
    expect(pages[1]?.error).toBeUndefined();
  });

  test('never fetches an image a page pointed at Nox’s own network', async () => {
    const requested: string[] = [];
    globalThis.fetch = mock((input: Request | string | URL) => {
      const value =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requested.push(value);
      return Promise.resolve(
        Response.json({
          results: [
            {
              cleaned_html: '<p>hi</p>',
              media: { images: [{ src: 'http://169.254.169.254/latest/meta-data/' }] },
              success: true,
              url: 'https://example.test/nox',
            },
          ],
        }),
      );
    }) as unknown as typeof fetch;

    const { published, publisher } = recordingPublisher();
    const tools = new WebToolSet({
      extract: { module: 'crawl4ai', url: 'https://crawl.example.test' },
      type: 'web',
    });

    const content = await ran(
      tools.prepare('web_extract', { urls: ['https://example.test/nox'] }),
      context(publisher),
    );

    expect(requested).toEqual(['https://crawl.example.test/crawl']);
    expect(published.map((input) => input.declaredMediaType)).toEqual(['text/html']);
    const pages = parsed(content).pages as { images: { skipped?: string }[] }[];
    expect(pages[0]?.images[0]?.skipped).toBe('not a public address');
  });

  test('refuses to run without artifact output, which is what it produces', () => {
    const tools = new WebToolSet({
      extract: { module: 'crawl4ai', url: 'https://crawl.example.test' },
      type: 'web',
    });
    const execution = tools.prepare('web_extract', { urls: ['https://example.test'] });

    expect(ran(execution, context())).rejects.toThrow('Artifact output is not available');
  });
});

describe('browser over the camoufox module', () => {
  function browserTools(): WebToolSet {
    return new WebToolSet({
      browser: { module: 'camoufox', url: 'https://browser.example.test' },
      type: 'web',
    });
  }

  test('gives each action its own schema instead of one tool full of maybes', () => {
    const tools = browserTools();

    // A click needs a target, and the schema is what says so.
    expect(() => tools.prepare('browser_click', { tabId: 'tab-1' })).toThrow();
    expect(() => tools.prepare('browser_click', { ref: 'e3', tabId: 'tab-1' })).not.toThrow();
    // A tab is not optional anywhere but open.
    expect(() => tools.prepare('browser_navigate', { url: 'https://example.test/' })).toThrow();
    expect(() => tools.prepare('browser_open', {})).not.toThrow();
    // Waiting for nothing at all is not a wait.
    expect(() => tools.prepare('browser_wait', { tabId: 'tab-1' })).toThrow();
    expect(() => tools.prepare('browser_wait', { tabId: 'tab-1', timeoutMs: 500 })).not.toThrow();
  });

  test('opens a tab, then reads the page it landed on', async () => {
    const calls: string[] = [];
    globalThis.fetch = mock((input: Request | string | URL) => {
      const value =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(value);
      if (value.endsWith('/tabs')) return Promise.resolve(Response.json({ tabId: 'tab-7' }));
      return Promise.resolve(
        Response.json({
          refsCount: 12,
          snapshot: 'heading "Nox" [ref=e1]',
          url: 'https://example.test/',
        }),
      );
    }) as unknown as typeof fetch;

    const body = parsed(
      await ran(
        browserTools().prepare('browser_open', { url: 'https://example.test/' }),
        context(),
      ),
    );

    expect(calls[0]).toBe('https://browser.example.test/tabs');
    expect(calls[1]).toContain('/tabs/tab-7/snapshot');
    expect(body).toMatchObject({
      action: 'open',
      refs: 12,
      snapshot: 'heading "Nox" [ref=e1]',
      tabId: 'tab-7',
      url: 'https://example.test/',
    });
  });

  test('follows an interaction with the page it produced', async () => {
    const calls: string[] = [];
    globalThis.fetch = mock((input: Request | string | URL) => {
      const value =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(value);
      // camofox answers a click with an acknowledgement and no page at all.
      if (value.includes('/click')) {
        return Promise.resolve(
          Response.json({ ok: true, refsAvailable: true, url: 'https://example.test/next' }),
        );
      }
      return Promise.resolve(
        Response.json({
          refsCount: 3,
          snapshot: 'button "Continue" [ref=e2]',
          url: 'https://example.test/next',
        }),
      );
    }) as unknown as typeof fetch;

    const body = parsed(
      await ran(browserTools().prepare('browser_click', { ref: 'e1', tabId: 'tab-7' }), context()),
    );

    // Refs from before the click describe a page that no longer exists, so the
    // fresh ones come back with the click.
    expect(calls[1]).toContain('/tabs/tab-7/snapshot');
    expect(body).toMatchObject({
      action: 'click',
      refs: 3,
      snapshot: 'button "Continue" [ref=e2]',
      url: 'https://example.test/next',
    });
  });

  test('publishes a screenshot that arrives as image bytes rather than as JSON', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { 'content-type': 'image/png' },
        }),
      ),
    ) as unknown as typeof fetch;

    const { published, publisher } = recordingPublisher();
    const content = await ran(
      browserTools().prepare('browser_screenshot', { tabId: 'tab-7' }),
      context(publisher),
    );

    expect(published[0]?.declaredMediaType).toBe('image/png');
    expect(parsed(content).screenshotArtifactId).toBe('art_00000001');
    expect(content[1]?.type).toBe('artifact');
  });

  test('reads the links this server sends, whichever field it names them in', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        Response.json({
          links: [
            { text: 'Learn more', url: 'https://iana.example/domains' },
            { href: '/docs', text: 'Docs' },
          ],
          url: 'https://example.test/',
        }),
      ),
    ) as unknown as typeof fetch;

    const body = parsed(
      await ran(browserTools().prepare('browser_links', { tabId: 'tab-7' }), context()),
    );

    expect(body.links).toEqual([
      { text: 'Learn more', url: 'https://iana.example/domains' },
      { text: 'Docs', url: 'https://example.test/docs' },
    ]);
  });

  test('reports an empty acknowledgement as a closed tab, not as a broken service', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('', { status: 200 })),
    ) as unknown as typeof fetch;

    const body = parsed(
      await ran(browserTools().prepare('browser_close', { tabId: 'tab-7' }), context()),
    );

    expect(body).toEqual({ action: 'close', closed: true, tabId: 'tab-7' });
  });

  test('says a selector matched nothing, rather than repeating camofox’s advice', () => {
    // camofox answers an unmatched CSS selector with the same 409 it uses for a
    // page that really moved, and advises retrying with fresh refs — advice a
    // selector can never satisfy.
    globalThis.fetch = mock(() =>
      Promise.resolve(
        Response.json(
          {
            code: 'page_changed',
            error: 'Page changed during type. Call snapshot to see the current state.',
            recovery: 'snapshot_then_retry',
          },
          { status: 409 },
        ),
      ),
    ) as unknown as typeof fetch;

    const execution = browserTools().prepare('browser_type', {
      selector: 'input[name=q]',
      tabId: 'tab-7',
      text: 'nox agents',
    });

    expect(ran(execution, context())).rejects.toThrow(
      /No element matched the CSS selector input\[name=q\].*address the element by its ref/su,
    );
  });

  test('says a ref is gone, rather than reporting an internal server error', () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        Response.json(
          { code: 'stale_refs', error: 'Internal server error', ref: 'e99' },
          { status: 422 },
        ),
      ),
    ) as unknown as typeof fetch;

    const execution = browserTools().prepare('browser_click', { ref: 'e99', tabId: 'tab-7' });

    expect(ran(execution, context())).rejects.toThrow(/The ref e99 is not on this page any more/u);
  });

  test('runs one call at a time against one tab, and both tabs at once', async () => {
    const open: string[] = [];
    let overlapped = false;
    globalThis.fetch = mock((input: Request | string | URL) => {
      const value =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const tab = value.split('/tabs/')[1]?.split('/')[0] ?? '';
      if (open.includes(tab)) overlapped = true;
      open.push(tab);

      return new Promise((resolve) => {
        setTimeout(() => {
          open.splice(open.indexOf(tab), 1);
          resolve(Response.json({ ok: true, snapshot: 'page', url: 'https://example.test/' }));
        }, 10);
      });
    }) as unknown as typeof fetch;

    const tools = browserTools();
    const scroll = (tabId: string) =>
      ran(tools.prepare('browser_scroll', { direction: 'down', tabId }), context());

    await Promise.all([scroll('tab-a'), scroll('tab-a'), scroll('tab-b')]);

    // Two hands on one wheel is what produced the unexplainable 500s.
    expect(overlapped).toBe(false);
  });

  test('separates looking at a page from acting on one', () => {
    const tools = browserTools();

    const click = tools.prepare('browser_click', { ref: 'e3', tabId: 'tab-7' });
    const snapshot = tools.prepare('browser_snapshot', { tabId: 'tab-7' });

    expect(click.risk?.effects).toContain('write');
    expect(click.risk?.reversible).toBe(false);
    expect(tools.tools.browser_click?.authority).toBe('nox.toolset.web.browser.act');
    expect(snapshot.risk?.effects).not.toContain('write');
    expect(snapshot.risk?.reversible).toBe(true);
    expect(tools.tools.browser_snapshot?.authority).toBe('nox.toolset.web.browser.read');
  });
});
