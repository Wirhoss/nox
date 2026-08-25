import { nanoid } from 'nanoid';
import { z } from 'zod';

import { publicUrl } from '../../http';
import { runtimeCredentialSchema, type WebModule, type WebModuleConfig } from '../../module';
import { evaluationResult } from './evaluate';
import { inspectionExpression, inspectionResult } from './inspect';

import type {
  BrowserAction,
  BrowserCapability,
  BrowserOutcome,
  BrowserRequest,
  PageImage,
  PageLink,
  WebRequestContext,
} from '../../capabilities';
import type { Browser, BrowserContext, BrowserType, Locator, Page } from 'playwright';

const PLAYWRIGHT_BROWSERS = ['chromium', 'firefox', 'webkit'] as const;
type PlaywrightBrowserName = (typeof PLAYWRIGHT_BROWSERS)[number];

const PLAYWRIGHT_ACTIONS: readonly BrowserAction[] = Object.freeze([
  'click',
  'close',
  'images',
  'inspect',
  'links',
  'navigate',
  'open',
  'press',
  'screenshot',
  'scroll',
  'snapshot',
  'type',
  'wait',
]);
const PLAYWRIGHT_EVALUATE_ACTIONS: readonly BrowserAction[] = Object.freeze([
  ...PLAYWRIGHT_ACTIONS,
  'evaluate',
]);

type PlaywrightTypes = Readonly<Record<PlaywrightBrowserName, BrowserType>>;
type PlaywrightLoader = () => Promise<PlaywrightTypes>;

/** The heavyweight client is not evaluated until a configured browser is first used. */
async function loadPlaywright(): Promise<PlaywrightTypes> {
  const loaded = await import('playwright');
  return Object.freeze({
    chromium: loaded.chromium,
    firefox: loaded.firefox,
    webkit: loaded.webkit,
  });
}

const webSocketUrlSchema = z
  .url()
  .refine(
    (value) => ['ws:', 'wss:'].includes(new URL(value).protocol),
    'Use a ws:// or wss:// URL.',
  );

function playwrightFields<TCredential extends z.ZodType>(credential: TCredential) {
  return {
    apiKey: credential.optional().meta({
      nox: { help: 'ui.playwright.credentialHelp', label: 'ui.credential', secret: true },
    }),
    browser: z
      .enum(PLAYWRIGHT_BROWSERS)
      .default('chromium')
      .meta({ nox: { help: 'ui.playwright.browserHelp', label: 'ui.playwright.browser' } }),
    enableEvaluate: z
      .boolean()
      .default(false)
      .meta({
        nox: {
          help: 'ui.browser.enableEvaluateHelp',
          label: 'ui.browser.enableEvaluate',
        },
      }),
    executablePath: z
      .string()
      .trim()
      .min(1)
      .optional()
      .meta({
        nox: {
          help: 'ui.playwright.executablePathHelp',
          label: 'ui.playwright.executablePath',
        },
      }),
    headless: z
      .boolean()
      .default(true)
      .meta({ nox: { help: 'ui.playwright.headlessHelp', label: 'ui.playwright.headless' } }),
    maxSnapshotCharacters: z
      .number()
      .int()
      .positive()
      .max(200_000)
      .default(24_000)
      .meta({ nox: { help: 'ui.playwright.snapshotHelp', label: 'ui.playwright.snapshot' } }),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(120_000)
      .default(30_000)
      .meta({ nox: { label: 'ui.timeout' } }),
    wsEndpoint: webSocketUrlSchema.optional().meta({
      nox: { help: 'ui.playwright.wsEndpointHelp', label: 'ui.playwright.wsEndpoint' },
    }),
  };
}

const playwrightConfigSchema = z.object(playwrightFields(runtimeCredentialSchema));

type PlaywrightConfig = z.infer<typeof playwrightConfigSchema>;

interface PlaywrightTab {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly session: string;
}

/**
 * A Playwright browser owned by this tool-set instance.
 *
 * Browser and contexts are lazy: merely validating settings never starts a
 * process or opens a remote connection. Each Nox browser session gets an
 * isolated Playwright context, while the tab ID returned to the agent names one
 * page inside it.
 */
class PlaywrightBrowser implements BrowserCapability {
  readonly #config: PlaywrightConfig;
  readonly #queues = new Map<string, Promise<void>>();
  readonly #sessions = new Map<string, Promise<BrowserContext>>();
  readonly #tabs = new Map<string, PlaywrightTab>();
  readonly #load: PlaywrightLoader;

  #browser?: Promise<Browser>;

  constructor(config: PlaywrightConfig, load: PlaywrightLoader = loadPlaywright) {
    this.#config = config;
    this.#load = load;
  }

  public get actions(): readonly BrowserAction[] {
    return this.#config.enableEvaluate ? PLAYWRIGHT_EVALUATE_ACTIONS : PLAYWRIGHT_ACTIONS;
  }

  public get maxSnapshotCharacters(): number {
    return this.#config.maxSnapshotCharacters;
  }

  public get origin(): string {
    return this.#config.wsEndpoint ?? `playwright://${this.#config.browser}`;
  }

  /** Calls against one page are serialized; separate tabs remain parallel. */
  public act(request: BrowserRequest, context: WebRequestContext): Promise<BrowserOutcome> {
    const queueKey = request.tabId ?? `open:${request.session}`;
    const queued = (this.#queues.get(queueKey) ?? Promise.resolve()).then(
      () => this.#act(request, context),
      () => this.#act(request, context),
    );
    const settled = queued.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(queueKey, settled);
    void settled.then(() => {
      if (this.#queues.get(queueKey) === settled) this.#queues.delete(queueKey);
    });
    return queued;
  }

  async #act(request: BrowserRequest, context: WebRequestContext): Promise<BrowserOutcome> {
    const { signal } = context;

    switch (request.action) {
      case 'click': {
        const tab = this.#tab(request.tabId);
        const target = await this.#target(tab.page, request, signal);
        await target.click({ signal });
        return tab.page.isClosed()
          ? Object.freeze({ closed: true, tabId: request.tabId })
          : this.#pageOutcome(tab.page, this.#tabId(request.tabId), signal);
      }
      case 'close': {
        const tabId = this.#tabId(request.tabId);
        const tab = this.#tab(tabId);
        await tab.page.close({ runBeforeUnload: false });
        this.#closed(tabId, tab);
        return Object.freeze({ closed: true, tabId });
      }
      case 'evaluate': {
        if (!this.#config.enableEvaluate) {
          throw new Error('browser_evaluate is disabled for this Playwright module.');
        }
        const tabId = this.#tabId(request.tabId);
        const page = this.#tab(tabId).page;
        signal.throwIfAborted();
        const result: unknown = await page.evaluate(this.#expression(request.expression));
        signal.throwIfAborted();
        return Object.freeze({
          evaluation: { result: evaluationResult(result) },
          tabId,
          url: page.url(),
        });
      }
      case 'images': {
        const tabId = this.#tabId(request.tabId);
        const page = this.#tab(tabId).page;
        return Object.freeze({ images: await pageImages(page, signal), tabId });
      }
      case 'inspect': {
        const tabId = this.#tabId(request.tabId);
        const page = this.#tab(tabId).page;
        signal.throwIfAborted();
        const result: unknown = await page.evaluate(inspectionExpression(request));
        signal.throwIfAborted();
        return Object.freeze({ inspection: inspectionResult(result), tabId, url: page.url() });
      }
      case 'links': {
        const tabId = this.#tabId(request.tabId);
        const page = this.#tab(tabId).page;
        return Object.freeze({ links: await pageLinks(page, signal), tabId });
      }
      case 'navigate': {
        const tabId = this.#tabId(request.tabId);
        const page = this.#tab(tabId).page;
        await page.goto(this.#url(request.url), {
          signal,
          timeout: this.#config.timeoutMs,
          waitUntil: 'domcontentloaded',
        });
        return this.#pageOutcome(page, tabId, signal);
      }
      case 'open': {
        return this.#open(request, signal);
      }
      case 'press': {
        const tabId = this.#tabId(request.tabId);
        const page = this.#tab(tabId).page;
        signal.throwIfAborted();
        await page.keyboard.press(this.#key(request.key));
        signal.throwIfAborted();
        return page.isClosed()
          ? Object.freeze({ closed: true, tabId })
          : this.#pageOutcome(page, tabId, signal);
      }
      case 'screenshot': {
        const tabId = this.#tabId(request.tabId);
        const page = this.#tab(tabId).page;
        const bytes = await page.screenshot({ animations: 'disabled', type: 'png' });
        return Object.freeze({
          screenshot: { bytes: new Uint8Array(bytes), mediaType: 'image/png' },
          tabId,
          title: await page.title(),
          url: page.url(),
        });
      }
      case 'scroll': {
        const tabId = this.#tabId(request.tabId);
        const page = this.#tab(tabId).page;
        const amount = request.amount ?? 600;
        signal.throwIfAborted();
        await page.mouse.wheel(0, request.direction === 'up' ? -amount : amount);
        signal.throwIfAborted();
        return this.#pageOutcome(page, tabId, signal);
      }
      case 'snapshot': {
        const tabId = this.#tabId(request.tabId);
        return this.#pageOutcome(this.#tab(tabId).page, tabId, signal);
      }
      case 'type': {
        const tabId = this.#tabId(request.tabId);
        const page = this.#tab(tabId).page;
        const target = await this.#target(page, request, signal);
        const text = request.text ?? '';
        if (request.clear === true) await target.fill(text, { signal });
        else await target.pressSequentially(text, { signal });
        if (request.submit === true) await target.press('Enter', { signal });
        return page.isClosed()
          ? Object.freeze({ closed: true, tabId })
          : this.#pageOutcome(page, tabId, signal);
      }
      case 'wait': {
        const tabId = this.#tabId(request.tabId);
        const page = this.#tab(tabId).page;
        const timeoutMs = request.timeoutMs ?? this.#config.timeoutMs;
        if (request.selector === undefined) await delay(timeoutMs, signal);
        else {
          await page
            .locator(request.selector)
            .waitFor({ signal, state: 'visible', timeout: timeoutMs });
        }
        return this.#pageOutcome(page, tabId, signal);
      }
    }
  }

  async #browserInstance(): Promise<Browser> {
    if (this.#browser !== undefined) return this.#browser;

    const started = this.#startBrowser();
    this.#browser = started;
    void started.then(
      (browser) => {
        browser.once('disconnected', () => {
          if (this.#browser === started) this.#browser = undefined;
          this.#sessions.clear();
          this.#tabs.clear();
        });
      },
      () => {
        if (this.#browser === started) this.#browser = undefined;
      },
    );
    return started;
  }

  /** Removes a tab and closes its context once that session has no pages left. */
  #closed(tabId: string, tab: PlaywrightTab): void {
    if (this.#tabs.get(tabId) !== tab) return;
    this.#tabs.delete(tabId);
    if ([...this.#tabs.values()].some((candidate) => candidate.session === tab.session)) return;

    const context = this.#sessions.get(tab.session);
    if (context === undefined) return;
    this.#sessions.delete(tab.session);
    void context.then((value) => value.close()).catch(() => undefined);
  }

  async #open(request: BrowserRequest, signal: AbortSignal): Promise<BrowserOutcome> {
    signal.throwIfAborted();
    const context = await this.#session(request.session);
    signal.throwIfAborted();
    const page = await context.newPage();
    const tabId = `pw_${nanoid(16)}`;
    const tab: PlaywrightTab = Object.freeze({ context, page, session: request.session });
    this.#tabs.set(tabId, tab);
    page.once('close', () => {
      this.#closed(tabId, tab);
    });

    try {
      if (request.url !== undefined) {
        await page.goto(request.url, {
          signal,
          timeout: this.#config.timeoutMs,
          waitUntil: 'domcontentloaded',
        });
      }
      return await this.#pageOutcome(page, tabId, signal);
    } catch (error) {
      await page.close().catch(() => undefined);
      this.#closed(tabId, tab);
      throw error;
    }
  }

  async #pageOutcome(page: Page, tabId: string, signal: AbortSignal): Promise<BrowserOutcome> {
    const [text, title] = await Promise.all([
      page.ariaSnapshot({ mode: 'ai', signal, timeout: this.#config.timeoutMs }),
      page.title(),
    ]);
    return Object.freeze({
      snapshot: { refs: (text.match(/\[ref=e\d+\]/gu) ?? []).length, text },
      tabId,
      title,
      url: page.url(),
    });
  }

  async #session(name: string): Promise<BrowserContext> {
    const existing = this.#sessions.get(name);
    if (existing !== undefined) return existing;

    const created = this.#browserInstance().then(async (browser) => {
      const context = await browser.newContext({ viewport: { height: 720, width: 1280 } });
      context.setDefaultNavigationTimeout(this.#config.timeoutMs);
      context.setDefaultTimeout(this.#config.timeoutMs);
      return context;
    });
    this.#sessions.set(name, created);
    void created.catch(() => {
      if (this.#sessions.get(name) === created) this.#sessions.delete(name);
    });
    return created;
  }

  async #startBrowser(): Promise<Browser> {
    const browserType = (await this.#load())[this.#config.browser];
    const endpoint = this.#config.wsEndpoint;
    if (endpoint !== undefined) {
      const apiKey = this.#config.apiKey;
      return browserType.connect(endpoint, {
        ...(apiKey === undefined
          ? {}
          : { headers: { Authorization: `Bearer ${apiKey.reveal()}` } }),
        timeout: this.#config.timeoutMs,
      });
    }

    const executablePath =
      this.#config.executablePath ??
      (this.#config.browser === 'chromium'
        ? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        : undefined);
    return browserType.launch({
      ...(executablePath === undefined ? {} : { executablePath }),
      headless: this.#config.headless,
      timeout: this.#config.timeoutMs,
    });
  }

  #tab(tabId: string | undefined): PlaywrightTab {
    const id = this.#tabId(tabId);
    const tab = this.#tabs.get(id);
    if (tab === undefined || tab.page.isClosed()) {
      throw new Error(`No Playwright tab is called ${id}. Open a new tab with browser_open.`);
    }
    return tab;
  }

  #tabId(tabId: string | undefined): string {
    if (tabId === undefined || tabId.length === 0) {
      throw new Error('This browser action needs the tabId returned by browser_open.');
    }
    return tabId;
  }

  async #target(page: Page, request: BrowserRequest, signal: AbortSignal): Promise<Locator> {
    const ref = request.ref;
    const selector = request.selector;
    const locator =
      ref !== undefined ? page.locator(`aria-ref=${ref}`) : page.locator(selector ?? ':focus');
    signal.throwIfAborted();
    const count = await locator.count();
    signal.throwIfAborted();

    if (count === 0 && ref !== undefined) {
      throw new Error(
        `The ref ${ref} is not on this page any more. Take a browser_snapshot and use a ref from it.`,
      );
    }
    if (count === 0 && selector === undefined) {
      throw new Error('No element is focused on this page. Use a ref from browser_snapshot.');
    }
    if (count === 0) {
      throw new Error(`No element matched the CSS selector ${selector ?? ''} on this page.`);
    }
    if (count > 1) {
      throw new Error(
        `The CSS selector ${selector ?? ':focus'} matched ${String(count)} elements. Use a ref from ` +
          'browser_snapshot or a selector that identifies one element.',
      );
    }
    return locator;
  }

  #expression(expression: string | undefined): string {
    if (expression === undefined || expression.length === 0) {
      throw new Error('The evaluate action needs a JavaScript expression.');
    }
    return expression;
  }

  #key(key: string | undefined): string {
    if (key === undefined || key.length === 0) throw new Error('The press action needs a key.');
    return key;
  }

  #url(url: string | undefined): string {
    if (url === undefined) throw new Error('The navigate action needs a URL.');
    return url;
  }
}

async function pageImages(page: Page, signal: AbortSignal): Promise<readonly PageImage[]> {
  const images = page.locator('img');
  signal.throwIfAborted();
  const count = await images.count();
  const found = await Promise.all(
    Array.from({ length: count }, async (_, index): Promise<PageImage | undefined> => {
      const image = images.nth(index);
      const [alt, source, box] = await Promise.all([
        image.getAttribute('alt', { signal }),
        image.getAttribute('src', { signal }),
        image.boundingBox({ signal }),
      ]);
      if (source === null) return undefined;
      const url = publicUrl(source, page.url());
      if (url === undefined) return undefined;
      const text = alt?.trim();
      return Object.freeze({
        ...(text === undefined || text.length === 0 ? {} : { alt: text }),
        ...(box === null || box.height <= 0 ? {} : { height: Math.round(box.height) }),
        url,
        ...(box === null || box.width <= 0 ? {} : { width: Math.round(box.width) }),
      });
    }),
  );
  signal.throwIfAborted();
  return Object.freeze(found.filter((image): image is PageImage => image !== undefined));
}

async function pageLinks(page: Page, signal: AbortSignal): Promise<readonly PageLink[]> {
  const links = page.locator('a[href]');
  signal.throwIfAborted();
  const count = await links.count();
  const found = await Promise.all(
    Array.from({ length: count }, async (_, index): Promise<PageLink | undefined> => {
      const link = links.nth(index);
      const [source, text] = await Promise.all([
        link.getAttribute('href', { signal }),
        link.innerText({ signal }),
      ]);
      if (source === null) return undefined;
      const url = publicUrl(source, page.url());
      if (url === undefined) return undefined;
      const label = text.trim();
      return Object.freeze({ ...(label.length === 0 ? {} : { text: label }), url });
    }),
  );
  signal.throwIfAborted();
  return Object.freeze(found.filter((link): link is PageLink => link !== undefined));
}

function delay(timeoutMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(done, timeoutMs);

    function aborted(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    }

    function done(): void {
      signal.removeEventListener('abort', aborted);
      resolve();
    }

    signal.addEventListener('abort', aborted, { once: true });
  });
}

const playwrightModule: WebModule<'browser'> = Object.freeze({
  config: playwrightFields,
  create: (config: WebModuleConfig): BrowserCapability =>
    new PlaywrightBrowser(playwrightConfigSchema.parse(config)),
  id: 'playwright',
});

export { PlaywrightBrowser, playwrightModule };

export type { PlaywrightConfig };
