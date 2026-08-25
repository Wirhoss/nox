import { describe, expect, test } from 'bun:test';

import { WebToolSet } from '../../webToolSet';
import { webModules } from '../index';
import { PlaywrightBrowser } from './playwright';

import type { Browser, BrowserContext, BrowserType, Locator, Page } from 'playwright';

function config(enableEvaluate = false) {
  return {
    browser: 'chromium' as const,
    enableEvaluate,
    headless: true,
    maxSnapshotCharacters: 24_000,
    timeoutMs: 30_000,
  };
}

function requestContext() {
  return { signal: new AbortController().signal };
}

function fakePlaywright(): {
  readonly clicked: string[];
  readonly contextsClosed: () => number;
  readonly evaluated: string[];
  readonly launchOptions: () => unknown;
  readonly load: () => Promise<Readonly<Record<'chromium' | 'firefox' | 'webkit', BrowserType>>>;
  readonly loads: () => number;
} {
  const clicked: string[] = [];
  const evaluated: string[] = [];
  let closeListener: (() => void) | undefined;
  let contextsClosed = 0;
  let launchedWith: unknown;
  let loadCount = 0;
  let snapshot = '- heading "Start" [level=1]\n- button "Continue" [ref=e7]';

  const target = {
    click: (): Promise<void> => {
      clicked.push('aria-ref=e7');
      snapshot = '- heading "Done" [level=1]\n- button "Again" [ref=e8]';
      return Promise.resolve();
    },
    count: (): Promise<number> => Promise.resolve(1),
  } as unknown as Locator;

  const page = {
    ariaSnapshot: (): Promise<string> => Promise.resolve(snapshot),
    close: (): Promise<void> => {
      closeListener?.();
      return Promise.resolve();
    },
    evaluate: (expression: string): Promise<unknown> => {
      evaluated.push(expression);
      if (expression.includes('noxBrowserInspect')) {
        return Promise.resolve({
          matches: [
            {
              id: 'continue',
              interactive: true,
              interactionSignals: ['pointer cursor'],
              selector: '#continue',
              tag: 'div',
              text: 'Continue',
              visible: true,
            },
          ],
          total: 1,
          truncated: false,
        });
      }
      if (expression === '1n') return Promise.resolve(1n);
      return Promise.resolve('Example');
    },
    goto: (): Promise<null> => Promise.resolve(null),
    isClosed: (): boolean => false,
    keyboard: { press: (): Promise<void> => Promise.resolve() },
    locator: (selector: string): Locator => {
      expect(selector).toBe('aria-ref=e7');
      return target;
    },
    mouse: { wheel: (): Promise<void> => Promise.resolve() },
    once: (event: string, listener: () => void): Page => {
      if (event === 'close') closeListener = listener;
      return page;
    },
    screenshot: (): Promise<Buffer> => Promise.resolve(Buffer.from([137, 80, 78, 71])),
    title: (): Promise<string> => Promise.resolve('Example'),
    url: (): string => 'https://example.test/',
  } as unknown as Page;

  const browserContext = {
    close: (): Promise<void> => {
      contextsClosed += 1;
      return Promise.resolve();
    },
    newPage: (): Promise<Page> => Promise.resolve(page),
    setDefaultNavigationTimeout: (): void => undefined,
    setDefaultTimeout: (): void => undefined,
  } as unknown as BrowserContext;

  const browser = {
    newContext: (): Promise<BrowserContext> => Promise.resolve(browserContext),
    once: (): Browser => browser,
  } as unknown as Browser;

  const browserType = {
    launch: (options: unknown): Promise<Browser> => {
      launchedWith = options;
      return Promise.resolve(browser);
    },
  } as unknown as BrowserType;

  return {
    clicked,
    contextsClosed: () => contextsClosed,
    evaluated,
    launchOptions: () => launchedWith,
    load: () => {
      loadCount += 1;
      return Promise.resolve({ chromium: browserType, firefox: browserType, webkit: browserType });
    },
    loads: () => loadCount,
  };
}

describe('Playwright browser module', () => {
  test('is registered beside camoufox and validates its own configuration', () => {
    expect(webModules.browser.map((module) => module.id)).toEqual(['camoufox', 'playwright']);

    const tools = new WebToolSet({
      browser: { browser: 'firefox', module: 'playwright' },
      type: 'web',
    });
    expect(Object.keys(tools.tools)).toContain('browser_inspect');
    expect(Object.keys(tools.tools)).toContain('browser_snapshot');
    expect(Object.keys(tools.tools)).not.toContain('browser_evaluate');

    const evaluating = new WebToolSet({
      browser: { enableEvaluate: true, module: 'playwright' },
      type: 'web',
    });
    expect(Object.keys(evaluating.tools)).toContain('browser_evaluate');

    expect(
      () =>
        new WebToolSet({
          browser: { module: 'playwright', wsEndpoint: 'https://browser.example.test' },
          type: 'web',
        } as never),
    ).toThrow(/ws:\/\/ or wss:\/\//u);
  });

  test('launches lazily, returns AI refs and uses a ref for the next action', async () => {
    const fake = fakePlaywright();
    const browser = new PlaywrightBrowser(config(), fake.load);
    expect(fake.loads()).toBe(0);

    const opened = await browser.act(
      { action: 'open', session: 'research', url: 'https://example.test/' },
      requestContext(),
    );
    const tabId = opened.tabId;
    expect(tabId).toStartWith('pw_');
    expect(opened.snapshot).toEqual({
      refs: 1,
      text: '- heading "Start" [level=1]\n- button "Continue" [ref=e7]',
    });
    expect(fake.launchOptions()).toEqual({ headless: true, timeout: 30_000 });
    expect(fake.loads()).toBe(1);

    const clicked = await browser.act(
      { action: 'click', ref: 'e7', session: 'research', tabId },
      requestContext(),
    );
    expect(fake.clicked).toEqual(['aria-ref=e7']);
    expect(clicked.snapshot?.text).toContain('heading "Done"');

    const inspected = await browser.act(
      { action: 'inspect', session: 'research', tabId, text: 'Continue' },
      requestContext(),
    );
    expect(inspected.inspection?.matches[0]).toMatchObject({
      interactive: true,
      selector: '#continue',
      tag: 'div',
    });
    expect(fake.evaluated.at(-1)).toContain('"text":"Continue"');

    await browser.act({ action: 'close', session: 'research', tabId }, requestContext());
    await Promise.resolve();
    expect(fake.contextsClosed()).toBe(1);
  });

  test('returns arbitrary evaluation results only when the module exposes the opt-in tool', async () => {
    const disabledFake = fakePlaywright();
    const disabled = new PlaywrightBrowser(config(), disabledFake.load);
    expect(
      disabled.act(
        { action: 'evaluate', expression: 'document.title', session: 'eval', tabId: 'missing' },
        requestContext(),
      ),
    ).rejects.toThrow('browser_evaluate is disabled');
    expect(disabledFake.loads()).toBe(0);

    const fake = fakePlaywright();
    const browser = new PlaywrightBrowser(config(true), fake.load);
    const opened = await browser.act({ action: 'open', session: 'eval' }, requestContext());

    const outcome = await browser.act(
      { action: 'evaluate', expression: 'document.title', session: 'eval', tabId: opened.tabId },
      requestContext(),
    );

    expect(outcome.evaluation?.result).toBe('Example');
    expect(fake.evaluated).toContain('document.title');

    const bigint = await browser.act(
      { action: 'evaluate', expression: '1n', session: 'eval', tabId: opened.tabId },
      requestContext(),
    );
    expect(bigint.evaluation?.result).toBe('1n');
  });
});
