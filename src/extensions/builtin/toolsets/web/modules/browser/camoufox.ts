import { z } from 'zod';

import { decodeBase64, publicUrl, WebService, WebServiceError } from '../../http';
import {
  endpointFields,
  runtimeCredentialSchema,
  type WebModule,
  type WebModuleConfig,
} from '../../module';

import type {
  BrowserAction,
  BrowserCapability,
  BrowserOutcome,
  BrowserRequest,
  PageImage,
  PageLink,
  WebRequestContext,
} from '../../capabilities';

/**
 * camofox: an anti-detection browser driven over HTTP, addressed as tabs inside
 * a named session.
 *
 * A browser is the one capability here that has a memory. Nothing in a tool call
 * can hold it: the run receives an abort signal and nothing else, so the tab is
 * the state, and it is named in the answer rather than kept on this object. A
 * model that opened a tab is handed its ID and passes it back; two agents
 * working at once name different sessions and never see each other's pages.
 */
const CAMOUFOX_ACTIONS: readonly BrowserAction[] = Object.freeze([
  'click',
  'close',
  'images',
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

function camoufoxFields<TCredential extends z.ZodType>(credential: TCredential) {
  return {
    ...endpointFields(credential, {
      timeoutMs: 60_000,
      url: 'The base URL of the camofox browser server.',
    }),
    maxSnapshotCharacters: z
      .number()
      .int()
      .positive()
      .max(200_000)
      .default(24_000)
      .meta({ nox: { help: 'ui.camoufox.snapshotHelp', label: 'ui.camoufox.snapshot' } }),
    userId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .default('nox')
      .meta({ nox: { help: 'ui.camoufox.userIdHelp', label: 'ui.camoufox.userId' } }),
  };
}

const camoufoxConfigSchema = z.object(camoufoxFields(runtimeCredentialSchema));

type CamoufoxConfig = z.infer<typeof camoufoxConfigSchema>;

interface CamoufoxSnapshot {
  hasMore?: boolean;
  nextOffset?: number;
  refsCount?: number;
  snapshot?: string;
  title?: string;
  totalChars?: number;
  truncated?: boolean;
  url?: string;
}

interface CamoufoxResponse extends CamoufoxSnapshot {
  images?: { alt?: string; height?: number; src?: string; url?: string; width?: number }[];
  /**
   * Both spellings are read because the running server and its published
   * OpenAPI disagree: the document says `href`, the deployment sends `url`, and
   * a module that believed either one alone silently returns no links at all.
   */
  links?: { href?: string; ref?: string; text?: string; url?: string }[];
  message?: string;
  ok?: boolean;
  screenshot?: { data?: string; mimeType?: string };
  tabId?: string;
}

/**
 * The actions that leave the page different from how the caller last saw it.
 *
 * camofox answers these with `{ok:true}` and nothing else, so a snapshot is
 * fetched behind them. That is not a convenience: element refs are how the next
 * click names its target, and refs from before a click describe a page that no
 * longer exists.
 */
const REFRESHING: ReadonlySet<BrowserAction> = new Set([
  'click',
  'navigate',
  'press',
  'scroll',
  'type',
  'wait',
]);

class CamoufoxBrowser implements BrowserCapability {
  readonly #config: CamoufoxConfig;
  /** One turnstile per tab, so calls against one page cannot overlap. */
  readonly #queues = new Map<string, Promise<void>>();
  readonly #service: WebService;

  constructor(config: CamoufoxConfig) {
    this.#config = config;
    this.#service = new WebService('camofox', config);
  }

  public get actions(): readonly BrowserAction[] {
    return CAMOUFOX_ACTIONS;
  }

  public get origin(): string {
    return this.#service.origin;
  }

  public get maxSnapshotCharacters(): number {
    return this.#config.maxSnapshotCharacters;
  }

  /**
   * One call at a time per tab.
   *
   * A tab is a single page being driven by a single browser, so two calls
   * against one tab are two hands on the same wheel: a scroll landing while a
   * navigate is in flight is how a run turns a page it never saw into a 500 it
   * cannot explain. Callers are not asked to remember that — the queue is per
   * tab, so separate tabs stay as parallel as they ever were.
   */
  public act(request: BrowserRequest, context: WebRequestContext): Promise<BrowserOutcome> {
    const tab = request.tabId ?? `open:${request.session}`;
    const queued = (this.#queues.get(tab) ?? Promise.resolve()).then(
      () => this.#act(request, context),
      () => this.#act(request, context),
    );

    // What is queued is the turn, never the answer: a failed call must not
    // become the failure of everything waiting behind it, and a promise nobody
    // is left holding cannot reject into an empty room.
    const settled = queued.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(tab, settled);
    void settled.then(() => {
      // Last one out closes the door. A turnstile still holding somebody else's
      // turn is not this call's to remove.
      if (this.#queues.get(tab) === settled) this.#queues.delete(tab);
    });

    return queued;
  }

  async #act(request: BrowserRequest, context: WebRequestContext): Promise<BrowserOutcome> {
    const userId = this.#config.userId;
    const { signal } = context;

    switch (request.action) {
      case 'click': {
        return this.#acted(request, signal, 'click', {
          ref: request.ref,
          selector: request.selector,
          userId,
        });
      }
      case 'close': {
        await this.#service.fetch(`/tabs/${encodeURIComponent(this.#tab(request.tabId))}`, {
          method: 'DELETE',
          query: { userId },
          signal,
        });
        return Object.freeze({ closed: true, tabId: request.tabId });
      }
      case 'images': {
        const body = await this.#get(request.tabId, 'images', signal);
        return Object.freeze({ images: images(body, body.url), tabId: request.tabId });
      }
      case 'links': {
        const body = await this.#get(request.tabId, 'links', signal);
        return Object.freeze({ links: links(body, body.url), tabId: request.tabId });
      }
      case 'navigate': {
        return this.#acted(request, signal, 'navigate', {
          sessionKey: request.session,
          url: request.url,
          userId,
        });
      }
      case 'open': {
        const opened = await this.#service.json<CamoufoxResponse>('/tabs', {
          body: { sessionKey: request.session, url: request.url, userId },
          signal,
        });
        const tabId = opened.tabId;
        if (tabId === undefined) throw new Error('camofox opened no tab.');
        if (request.url === undefined) return this.#outcome(opened, tabId);
        return this.#snapshot(tabId, signal);
      }
      case 'press': {
        return this.#acted(request, signal, 'press', { key: request.key, userId });
      }
      case 'screenshot': {
        return this.#screenshot(this.#tab(request.tabId), signal);
      }
      case 'scroll': {
        return this.#acted(request, signal, 'scroll', {
          amount: request.amount,
          direction: request.direction ?? 'down',
          userId,
        });
      }
      case 'snapshot': {
        return this.#snapshot(this.#tab(request.tabId), signal);
      }
      case 'type': {
        return this.#acted(request, signal, 'type', {
          clear: request.clear,
          ref: request.ref,
          selector: request.selector,
          submit: request.submit,
          text: request.text,
          userId,
        });
      }
      case 'wait': {
        // The wait is the caller's, so the request must outlive it rather than
        // time out underneath it while camofox is still counting.
        const timeout = request.timeoutMs ?? 10_000;
        return this.#acted(
          request,
          signal,
          'wait',
          { selector: request.selector, timeout, userId },
          timeout + 5_000,
        );
      }
    }
  }

  /**
   * An action, followed by the page it produced. The action's own answer is kept
   * for what it says — a URL it landed on, a message — and the snapshot is what
   * the caller actually needs back.
   */
  async #acted(
    request: BrowserRequest,
    signal: AbortSignal,
    path: string,
    body: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
  ): Promise<BrowserOutcome> {
    const tabId = this.#tab(request.tabId);
    const acted = await this.#post(tabId, path, signal, body, timeoutMs).catch((error: unknown) => {
      throw targeted(error, request);
    });
    if (!REFRESHING.has(request.action)) return this.#outcome(acted, tabId);

    const seen = await this.#snapshot(tabId, signal);
    return Object.freeze({
      ...this.#outcome(acted, tabId),
      ...seen,
    });
  }

  /**
   * A rendering of the tab. This deployment answers with the PNG itself while
   * its OpenAPI describes a base64 field, so both are accepted: what a service
   * documents and what it sends are two different facts, and only one of them
   * reaches a running agent.
   */
  async #screenshot(tabId: string, signal: AbortSignal): Promise<BrowserOutcome> {
    const captured = await this.#service.bytes(`/tabs/${encodeURIComponent(tabId)}/screenshot`, {
      query: { userId: this.#config.userId },
      signal,
    });

    if (captured.mediaType.startsWith('image/')) {
      return Object.freeze({
        screenshot: { bytes: captured.bytes, mediaType: captured.mediaType },
        tabId,
      });
    }

    const body = decoded(captured.bytes);
    const data = body?.screenshot?.data;
    const bytes = data === undefined ? undefined : decodeBase64(data);
    if (bytes === undefined) throw new Error('camofox returned no screenshot.');
    return Object.freeze({
      screenshot: { bytes, mediaType: body?.screenshot?.mimeType ?? 'image/png' },
      tabId,
      ...(body?.url === undefined ? {} : { url: body.url }),
    });
  }

  /** A snapshot after an action, which is what makes the next ref addressable. */
  async #snapshot(tabId: string, signal: AbortSignal): Promise<BrowserOutcome> {
    const body = await this.#service.json<CamoufoxResponse>(
      `/tabs/${encodeURIComponent(tabId)}/snapshot`,
      { query: { format: 'text', userId: this.#config.userId }, signal },
    );
    return this.#outcome(body, tabId);
  }

  #get(tabId: string | undefined, path: string, signal: AbortSignal): Promise<CamoufoxResponse> {
    return this.#service.json<CamoufoxResponse>(
      `/tabs/${encodeURIComponent(this.#tab(tabId))}/${path}`,
      { query: { userId: this.#config.userId }, signal },
    );
  }

  #post(
    tabId: string | undefined,
    path: string,
    signal: AbortSignal,
    body: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
  ): Promise<CamoufoxResponse> {
    return this.#service.json<CamoufoxResponse>(
      `/tabs/${encodeURIComponent(this.#tab(tabId))}/${path}`,
      { body, signal, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
    );
  }

  #outcome(body: CamoufoxResponse, tabId: string | undefined): BrowserOutcome {
    const id = body.tabId ?? tabId;
    const text = body.snapshot;
    return Object.freeze({
      ...(body.message === undefined ? {} : { detail: body.message }),
      ...(id === undefined ? {} : { tabId: id }),
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.url === undefined ? {} : { url: body.url }),
      ...(text === undefined
        ? {}
        : {
            snapshot: {
              ...(body.hasMore === undefined ? {} : { hasMore: body.hasMore }),
              ...(body.nextOffset === undefined ? {} : { nextOffset: body.nextOffset }),
              ...(body.refsCount === undefined ? {} : { refs: body.refsCount }),
              text,
            },
          }),
    });
  }

  /** Every action but `open` addresses a tab, and a missing one is the caller's error. */
  #tab(tabId: string | undefined): string {
    if (tabId === undefined || tabId.length === 0) {
      throw new Error('This browser action needs the tabId returned by open.');
    }
    return tabId;
  }
}

/**
 * camofox's refusal, said again in terms of the call that was made.
 *
 * Its `page_changed` covers two different events: the page really moved under
 * the call, and the CSS selector matched nothing at all. It advises the same
 * recovery for both — take a snapshot, retry with current refs — which is sound
 * for the first and impossible for the second, since a selector that matches
 * nothing will go on matching nothing however many snapshots are taken. A caller
 * following that advice retries until it gives up, which is exactly what
 * happened here. Only this module knows which of the two was asked for, so this
 * is where the sentence gets corrected.
 */
function targeted(error: unknown, request: BrowserRequest): unknown {
  if (!(error instanceof WebServiceError)) return error;

  const selector = request.selector;
  if (error.code === 'page_changed' && selector !== undefined && request.ref === undefined) {
    return new Error(
      `No element matched the CSS selector ${selector} on this page, or the page changed while ` +
        `the ${request.action} was running. Take a browser_snapshot and address the element by ` +
        'its ref instead; refs come from the page as it is now.',
      { cause: error },
    );
  }
  if (error.code === 'page_changed') {
    return new Error(
      `The page changed while the ${request.action} was running. Take a browser_snapshot and ` +
        'retry with a ref from it.',
      { cause: error },
    );
  }
  if (error.code === 'stale_refs') {
    return new Error(
      `The ref ${request.ref ?? ''} is not on this page any more. Take a browser_snapshot and ` +
        'use a ref from it.',
      { cause: error },
    );
  }
  return error;
}

/** A JSON body that arrived as bytes, or nothing when it is not JSON at all. */
function decoded(bytes: Uint8Array): CamoufoxResponse | undefined {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as CamoufoxResponse;
  } catch {
    return undefined;
  }
}

function images(body: CamoufoxResponse, pageUrl: string | undefined): readonly PageImage[] {
  return Object.freeze(
    (body.images ?? []).flatMap((image): PageImage[] => {
      const source = image.src ?? image.url;
      const url = source === undefined ? undefined : publicUrl(source, pageUrl);
      if (url === undefined) return [];
      return [
        Object.freeze({
          ...(image.alt === undefined || image.alt.length === 0 ? {} : { alt: image.alt }),
          ...(image.height === undefined ? {} : { height: image.height }),
          ...(image.width === undefined ? {} : { width: image.width }),
          url,
        }),
      ];
    }),
  );
}

function links(body: CamoufoxResponse, pageUrl: string | undefined): readonly PageLink[] {
  return Object.freeze(
    (body.links ?? []).flatMap((link): PageLink[] => {
      const source = link.href ?? link.url;
      const url = source === undefined ? undefined : publicUrl(source, pageUrl);
      if (url === undefined) return [];
      const text =
        link.text === undefined || link.text.trim().length === 0 ? undefined : link.text.trim();
      return [Object.freeze({ ...(text === undefined ? {} : { text }), url })];
    }),
  );
}

const camoufoxModule: WebModule<'browser'> = Object.freeze({
  config: camoufoxFields,
  create: (config: WebModuleConfig): BrowserCapability =>
    new CamoufoxBrowser(camoufoxConfigSchema.parse(config)),
  id: 'camoufox',
});

export { camoufoxModule };
