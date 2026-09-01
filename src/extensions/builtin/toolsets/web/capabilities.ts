/**
 * What the three web tools need from whatever is behind them.
 *
 * A tool talks to a capability, never to a service. SearXNG, Crawl4AI and
 * camoufox implement these; they do not define the shapes the tools use.
 * Everything specific to one service — its routes, its request
 * body, the name it gives a field — stops at the module boundary, and what
 * crosses is this.
 *
 * The declared limits and surfaces are part of the contract for the same reason.
 * A module that cannot take a language, cannot capture a PDF or cannot press a
 * key says so here, and the tool's parameters are built from the answer, so the
 * model is never offered an argument the configured module would have to refuse.
 */

/** Everything a module needs to make one request on a tool call's behalf. */
interface WebRequestContext {
  readonly signal: AbortSignal;
}

interface SearchResult {
  readonly publishedAt?: string;
  readonly snippet?: string;
  readonly source?: string;
  readonly title: string;
  readonly url: string;
}

interface SearchRequest {
  /** Only ever set when the capability declared `languages`. */
  readonly language?: string;
  readonly maxResults: number;
  readonly query: string;
}

interface SearchCapability {
  readonly defaultLanguage?: string;
  /** The service behind this capability, named in the risk record of every call. */
  readonly origin: string;
  readonly defaultMaxResults: number;
  /** Whether results can be narrowed to a language, and the tool may ask for one. */
  readonly languages: boolean;
  readonly maxResults: number;
  search(request: SearchRequest, context: WebRequestContext): Promise<readonly SearchResult[]>;
}

/**
 * What a module can bring back from a page besides its text. These are the
 * things worth keeping as files, which is why they are named rather than folded
 * into one "content" blob: the tool publishes each as its own artifact.
 */
const PAGE_CAPTURES = ['html', 'images', 'markdown', 'pdf', 'screenshot'] as const;

type PageCapture = (typeof PAGE_CAPTURES)[number];

interface PageImage {
  readonly alt?: string;
  readonly description?: string;
  readonly height?: number;
  readonly url: string;
  readonly width?: number;
}

interface PageLink {
  readonly text?: string;
  readonly url: string;
}

interface PageBytes {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

/**
 * One crawled page. Every field beyond `url` is optional because a module
 * returns what it was asked for and what it managed to get: a page that failed
 * carries `error` and nothing else, and that is a result rather than a throw —
 * one dead URL in a batch must not lose the pages beside it.
 */
interface ExtractedPage {
  readonly error?: string;
  readonly html?: string;
  readonly images?: readonly PageImage[];
  readonly links?: readonly PageLink[];
  readonly markdown?: string;
  readonly pdf?: PageBytes;
  readonly screenshot?: PageBytes;
  readonly title?: string;
  readonly url: string;
}

interface ExtractRequest {
  readonly captures: readonly PageCapture[];
  readonly urls: readonly string[];
}

interface ExtractCapability {
  /** The captures this module can produce; the tool offers exactly these. */
  readonly captures: readonly PageCapture[];
  readonly defaultCaptures: readonly PageCapture[];
  readonly maxUrls: number;
  readonly origin: string;
  extract(request: ExtractRequest, context: WebRequestContext): Promise<readonly ExtractedPage[]>;
}

/**
 * The browser verbs. A module declares the ones it has, so a backend without
 * keyboard control simply never offers `press` rather than failing a call that
 * the model was invited to make.
 */
const BROWSER_ACTIONS = [
  'click',
  'close',
  'evaluate',
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
] as const;

type BrowserAction = (typeof BROWSER_ACTIONS)[number];

/**
 * One browser instruction. The union is flat rather than per-action because a
 * tool's parameters must be one object; which fields an action requires is
 * stated once, in `BROWSER_REQUIREMENTS`, and enforced before a module sees it.
 */
interface BrowserRequest {
  readonly action: BrowserAction;
  readonly amount?: number;
  readonly clear?: boolean;
  readonly direction?: 'down' | 'up';
  readonly exact?: boolean;
  readonly expression?: string;
  readonly key?: string;
  readonly maxResults?: number;
  readonly ref?: string;
  readonly selector?: string;
  /** Names the tab group a call belongs to, so two lines of work never share tabs. */
  readonly session: string;
  readonly submit?: boolean;
  readonly tabId?: string;
  readonly text?: string;
  readonly timeoutMs?: number;
  readonly url?: string;
}

/**
 * A page as the browser currently sees it. `snapshot` is an accessibility tree
 * with element refs rather than markup: refs are what the next click or keystroke
 * addresses, and handing the model raw HTML would leave it guessing at selectors.
 */
interface BrowserInspectionMatch {
  readonly attributes?: Readonly<Record<string, string>>;
  readonly box?: {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  };
  readonly classes?: readonly string[];
  readonly id?: string;
  readonly interactive: boolean;
  readonly interactionSignals?: readonly string[];
  readonly role?: string;
  /** A selector that uniquely identifies this element in the current document. */
  readonly selector: string;
  readonly tag: string;
  readonly text?: string;
  readonly visible: boolean;
}

interface BrowserInspection {
  readonly matches: readonly BrowserInspectionMatch[];
  readonly total: number;
  readonly truncated: boolean;
}

interface BrowserOutcome {
  readonly closed?: boolean;
  readonly detail?: string;
  readonly evaluation?: { readonly result: unknown };
  readonly images?: readonly PageImage[];
  readonly inspection?: BrowserInspection;
  readonly links?: readonly PageLink[];
  readonly screenshot?: PageBytes;
  readonly snapshot?: {
    readonly hasMore?: boolean;
    readonly nextOffset?: number;
    readonly refs?: number;
    readonly text: string;
  };
  readonly tabId?: string;
  readonly title?: string;
  readonly url?: string;
}

interface BrowserCapability {
  readonly actions: readonly BrowserAction[];
  /** Snapshot text the tool will inline before it becomes an artifact instead. */
  readonly maxSnapshotCharacters: number;
  readonly origin: string;
  act(request: BrowserRequest, context: WebRequestContext): Promise<BrowserOutcome>;
}

export { BROWSER_ACTIONS, PAGE_CAPTURES };

export type {
  BrowserAction,
  BrowserCapability,
  BrowserInspection,
  BrowserInspectionMatch,
  BrowserOutcome,
  BrowserRequest,
  ExtractCapability,
  ExtractedPage,
  ExtractRequest,
  PageBytes,
  PageCapture,
  PageImage,
  PageLink,
  SearchCapability,
  SearchRequest,
  SearchResult,
  WebRequestContext,
};
