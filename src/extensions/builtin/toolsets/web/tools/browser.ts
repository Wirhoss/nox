import {
  type ArtifactOutputPublisher,
  httpUrlSchema,
  type MessageContent,
  stableStringify,
  type Tool,
  type ToolEffect,
  z,
} from '@nox/extension-api';

import { publishBytes, publishText } from '../artifacts';

import type {
  BrowserAction,
  BrowserCapability,
  BrowserOutcome,
  BrowserRequest,
} from '../capabilities';

/**
 * Looking at a page and acting on one are two different permissions.
 *
 * A blueprint can grant an agent a browser it may read — open a page, snapshot
 * it, screenshot it — without granting it the ability to click a button or type
 * into somebody's form. That distinction only exists because each action is its
 * own tool: behind one `browser` tool with an `action` argument there was one
 * authority covering both, and the difference could only be argued about after
 * the call had already been prepared.
 */
const BROWSER_READ_AUTHORITY = 'nox.toolset.web.browser.read';
const BROWSER_ACT_AUTHORITY = 'nox.toolset.web.browser.act';
const BROWSER_EVALUATE_AUTHORITY = 'nox.toolset.web.browser.evaluate';

/** Which actions change the page rather than only look at it. */
const INTERACTIONS: ReadonlySet<BrowserAction> = new Set([
  'click',
  'evaluate',
  'press',
  'scroll',
  'type',
]);

/** Which actions can bring a page back, and so may publish one as a file. */
const PUBLISHES: ReadonlySet<BrowserAction> = new Set([
  'click',
  'navigate',
  'open',
  'press',
  'screenshot',
  'scroll',
  'snapshot',
  'type',
  'wait',
]);

const tabIdField = z.string().min(1).max(128).describe('The tab, as returned by browser_open.');
const sessionField = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .default('default')
  .describe('Names the tab group. Separate lines of work should use separate sessions.');
const refField = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe('Element ref from the latest snapshot, such as e12. Prefer this over selector.');
const selectorField = z
  .string()
  .min(1)
  .max(500)
  .optional()
  .describe(
    'CSS selector, for an element the snapshot did not name. It is matched against the live ' +
      'page, so a selector that fits nothing fails the call; a ref is the reliable way.',
  );

interface BrowserToolOptions<TSchema extends z.ZodObject> {
  readonly action: BrowserAction;
  readonly capability: BrowserCapability;
  readonly description: string;
  readonly name: string;
  readonly origin: string;
  readonly parameters: TSchema;
  readonly request: (params: z.infer<TSchema>) => Partial<BrowserRequest>;
  readonly title: (params: z.infer<TSchema>) => string;
}

/**
 * One action, one tool, one schema that only mentions what that action takes.
 *
 * The single `browser` tool this replaces carried every field any action might
 * need, all of them optional, with a paragraph of prose explaining which
 * combinations were real — so a model learned the rules by having its calls
 * refused. Here `browser_click` asks for a tab and a target and nothing else,
 * and a call that could never have worked cannot be spelled.
 */
function browserTool<TSchema extends z.ZodObject>(options: BrowserToolOptions<TSchema>): Tool {
  const interactive = INTERACTIONS.has(options.action);
  const evaluating = options.action === 'evaluate';
  const effects: ToolEffect[] = evaluating
    ? ['credential', 'execute', 'network', 'read', 'write']
    : interactive
      ? ['network', 'read', 'write']
      : ['network', 'read'];

  const tool: Tool<TSchema> = {
    authority: evaluating
      ? BROWSER_EVALUATE_AUTHORITY
      : interactive
        ? BROWSER_ACT_AUTHORITY
        : BROWSER_READ_AUTHORITY,
    description: options.description,
    name: options.name,
    ...(PUBLISHES.has(options.action) ? { output: { artifacts: true as const } } : {}),
    parameters: options.parameters,
    prepare: (params) => {
      const built = options.request(params);

      return {
        risk: {
          effects,
          resources: [{ kind: 'url', value: built.url ?? options.origin }],
          // Typing into somebody's form or clicking their button is a change out
          // there, and no later call takes it back.
          reversible: !interactive,
        },
        run: async ({ abortSignal, artifacts }): Promise<MessageContent[]> => {
          const outcome = await options.capability.act(
            { ...built, action: options.action, session: built.session ?? 'default' },
            { signal: abortSignal },
          );
          return report(
            outcome,
            options.action,
            options.capability.maxSnapshotCharacters,
            artifacts,
          );
        },
        title: options.title(params),
        type: 'immediate',
      };
    },
    risk: { effects, reversible: !interactive },
  };

  return tool;
}

/**
 * Every browser tool there is, keyed by the action it performs.
 *
 * A table rather than a list, because the set an instance actually exposes is
 * the configured module's answer: `browserTools` builds only the entries the
 * module declared it can do. A module that cannot press a key never contributes
 * `browser_press`, without any tool here learning the module's name. Keying the
 * table by the complete action union also makes a newly declared action a type
 * error here until it has a tool, rather than a capability that silently never
 * reaches an agent.
 */
const BUILDERS: Readonly<
  Record<BrowserAction, (capability: BrowserCapability, origin: string) => Tool>
> = {
  click: (capability, origin) =>
    browserTool({
      action: 'click',
      capability,
      description:
        'Click an element on an open page, by snapshot ref or CSS selector. ' +
        'Returns the page as it is after the click.',
      name: 'browser_click',
      origin,
      parameters: z
        .object({ ref: refField, selector: selectorField, tabId: tabIdField })
        .refine(
          (params) => params.ref !== undefined || params.selector !== undefined,
          'Name the element to click with ref or selector.',
        ),
      request: (params) => ({ ref: params.ref, selector: params.selector, tabId: params.tabId }),
      title: (params) => `Browser click — ${params.ref ?? params.selector ?? 'element'}`,
    }),

  close: (capability, origin) =>
    browserTool({
      action: 'close',
      capability,
      description: 'Close an open tab and release the page it was holding.',
      name: 'browser_close',
      origin,
      parameters: z.object({ tabId: tabIdField }),
      request: (params) => ({ tabId: params.tabId }),
      title: () => 'Browser close tab',
    }),

  evaluate: (capability, origin) =>
    browserTool({
      action: 'evaluate',
      capability,
      description:
        'Run an arbitrary JavaScript expression in an open page and return its serializable ' +
        'result. This opt-in tool can read page storage, make requests and change the page.',
      name: 'browser_evaluate',
      origin,
      parameters: z.object({
        expression: z
          .string()
          .trim()
          .min(1)
          .max(50_000)
          .describe('JavaScript expression to run in the page context.'),
        tabId: tabIdField,
      }),
      request: (params) => ({ expression: params.expression, tabId: params.tabId }),
      title: () => 'Browser evaluate JavaScript',
    }),

  images: (capability, origin) =>
    browserTool({
      action: 'images',
      capability,
      description: 'List the images an open page points at, with their alt text.',
      name: 'browser_images',
      origin,
      parameters: z.object({ tabId: tabIdField }),
      request: (params) => ({ tabId: params.tabId }),
      title: () => 'Browser page images',
    }),

  inspect: (capability, origin) =>
    browserTool({
      action: 'inspect',
      capability,
      description:
        'Find live DOM elements by text or CSS and report their tag, attributes, visibility, ' +
        'interaction signals and a unique selector. Use this when a visual control has no ' +
        'snapshot ref.',
      name: 'browser_inspect',
      origin,
      parameters: z
        .object({
          exact: z
            .boolean()
            .default(false)
            .describe('Require an exact normalized text match instead of a substring.'),
          maxResults: z
            .number()
            .int()
            .positive()
            .max(50)
            .default(10)
            .describe('Maximum matching elements to return.'),
          selector: selectorField,
          tabId: tabIdField,
          text: z
            .string()
            .trim()
            .min(1)
            .max(500)
            .optional()
            .describe('Visible or hidden DOM text to find, matched case-insensitively.'),
        })
        .refine(
          (params) => params.selector !== undefined || params.text !== undefined,
          'Inspect by text, selector, or both.',
        ),
      request: (params) => ({
        exact: params.exact,
        maxResults: params.maxResults,
        selector: params.selector,
        tabId: params.tabId,
        text: params.text,
      }),
      title: (params) => `Browser inspect — ${params.text ?? params.selector ?? 'element'}`,
    }),

  links: (capability, origin) =>
    browserTool({
      action: 'links',
      capability,
      description: 'List the links an open page points at, with their text.',
      name: 'browser_links',
      origin,
      parameters: z.object({ tabId: tabIdField }),
      request: (params) => ({ tabId: params.tabId }),
      title: () => 'Browser page links',
    }),

  navigate: (capability, origin) =>
    browserTool({
      action: 'navigate',
      capability,
      description: 'Point an open tab at another URL and return the page it lands on.',
      name: 'browser_navigate',
      origin,
      parameters: z.object({
        session: sessionField,
        tabId: tabIdField,
        url: httpUrlSchema('The page to navigate to.'),
      }),
      request: (params) => ({ session: params.session, tabId: params.tabId, url: params.url }),
      title: (params) => `Browser navigate — ${hostOf(params.url)}`,
    }),

  open: (capability, origin) =>
    browserTool({
      action: 'open',
      capability,
      description:
        'Open a browser tab, optionally at a URL, and return its tabId together with the ' +
        'page. Every other browser tool needs that tabId.',
      name: 'browser_open',
      origin,
      parameters: z.object({
        session: sessionField,
        url: httpUrlSchema('The page to open. Omit for an empty tab.').optional(),
      }),
      request: (params) => ({ session: params.session, url: params.url }),
      title: (params) =>
        params.url === undefined ? 'Browser open tab' : `Browser open — ${hostOf(params.url)}`,
    }),

  press: (capability, origin) =>
    browserTool({
      action: 'press',
      capability,
      description:
        'Press one key on an open page, such as Enter, Escape or Tab. ' +
        'Returns the page as it is afterwards.',
      name: 'browser_press',
      origin,
      parameters: z.object({
        key: z.string().min(1).max(40).describe('Key name, such as Enter, Escape or Tab.'),
        tabId: tabIdField,
      }),
      request: (params) => ({ key: params.key, tabId: params.tabId }),
      title: (params) => `Browser press — ${params.key}`,
    }),

  screenshot: (capability, origin) =>
    browserTool({
      action: 'screenshot',
      capability,
      description: 'Capture an open page as an image, published as a durable artifact.',
      name: 'browser_screenshot',
      origin,
      parameters: z.object({ tabId: tabIdField }),
      request: (params) => ({ tabId: params.tabId }),
      title: () => 'Browser screenshot',
    }),

  scroll: (capability, origin) =>
    browserTool({
      action: 'scroll',
      capability,
      description: 'Scroll an open page and return the page as it is afterwards.',
      name: 'browser_scroll',
      origin,
      parameters: z.object({
        amount: z.number().int().positive().max(20_000).optional().describe('Pixels to scroll.'),
        direction: z.enum(['down', 'up']).default('down').describe('Which way to scroll.'),
        tabId: tabIdField,
      }),
      request: (params) => ({
        amount: params.amount,
        direction: params.direction,
        tabId: params.tabId,
      }),
      title: (params) => `Browser scroll ${params.direction}`,
    }),

  snapshot: (capability, origin) =>
    browserTool({
      action: 'snapshot',
      capability,
      description:
        'Read an open page as an accessibility snapshot with element refs. ' +
        'Those refs are what browser_click and browser_type address.',
      name: 'browser_snapshot',
      origin,
      parameters: z.object({ tabId: tabIdField }),
      request: (params) => ({ tabId: params.tabId }),
      title: () => 'Browser snapshot',
    }),

  type: (capability, origin) =>
    browserTool({
      action: 'type',
      capability,
      description:
        'Type text into an element on an open page, optionally clearing it first or ' +
        'submitting afterwards. Returns the page as it is afterwards.',
      name: 'browser_type',
      origin,
      parameters: z.object({
        clear: z.boolean().default(false).describe('Clear the field before typing into it.'),
        ref: refField,
        selector: selectorField,
        submit: z.boolean().default(false).describe('Press Enter after typing.'),
        tabId: tabIdField,
        text: z.string().max(10_000).describe('The text to type.'),
      }),
      request: (params) => ({
        clear: params.clear,
        ref: params.ref,
        selector: params.selector,
        submit: params.submit,
        tabId: params.tabId,
        text: params.text,
      }),
      title: (params) => `Browser type — ${params.ref ?? params.selector ?? 'focused element'}`,
    }),

  wait: (capability, origin) =>
    browserTool({
      action: 'wait',
      capability,
      description:
        'Wait for an element to appear on an open page, or for a fixed delay, then return ' +
        'the page.',
      name: 'browser_wait',
      origin,
      parameters: z
        .object({
          selector: z.string().min(1).max(500).optional().describe('CSS selector to wait for.'),
          tabId: tabIdField,
          timeoutMs: z
            .number()
            .int()
            .positive()
            .max(120_000)
            .optional()
            .describe('How long to wait, in milliseconds.'),
        })
        .refine(
          (params) => params.selector !== undefined || params.timeoutMs !== undefined,
          'Wait for a selector, for a timeoutMs, or for both.',
        ),
      request: (params) => ({
        selector: params.selector,
        tabId: params.tabId,
        timeoutMs: params.timeoutMs,
      }),
      title: (params) => `Browser wait — ${params.selector ?? `${String(params.timeoutMs)}ms`}`,
    }),
};

/** The tools this configured module can back, in a stable order. */
function browserTools(capability: BrowserCapability, origin: string): readonly Tool[] {
  return [...capability.actions]
    .sort((a, b) => a.localeCompare(b))
    .map((action) => BUILDERS[action](capability, origin));
}

/**
 * The answer the model reads, with the heavy parts moved out of it.
 *
 * A screenshot is bytes and belongs in a file. A long snapshot is a page's whole
 * accessibility tree, and pasting all of it into the transcript would leave every
 * later turn paying for one glance at one page — so past the module's own
 * ceiling it becomes a file too, and what stays inline is the head of it plus
 * where the rest went.
 */
async function report(
  outcome: BrowserOutcome,
  action: BrowserAction,
  maxSnapshotCharacters: number,
  artifacts: ArtifactOutputPublisher | undefined,
): Promise<MessageContent[]> {
  const published: MessageContent[] = [];
  const summary: Record<string, unknown> = { action };

  if (outcome.tabId !== undefined) summary.tabId = outcome.tabId;
  if (outcome.url !== undefined) summary.url = outcome.url;
  if (outcome.title !== undefined) summary.title = outcome.title;
  if (outcome.detail !== undefined) summary.detail = outcome.detail;
  if (outcome.closed === true) summary.closed = true;
  if (outcome.evaluation !== undefined) summary.result = outcome.evaluation.result;
  if (outcome.inspection !== undefined) summary.inspection = outcome.inspection;
  if (outcome.links !== undefined) summary.links = outcome.links;
  if (outcome.images !== undefined) summary.images = outcome.images;

  if (outcome.screenshot !== undefined) {
    if (artifacts === undefined) {
      throw new Error('Artifact output is not available in this session.');
    }
    const artifact = await publishBytes(
      artifacts,
      outcome.screenshot,
      `${hostOf(outcome.url)}-screenshot.png`,
    );
    published.push(artifact);
    summary.screenshotArtifactId = artifact.artifact.artifactId;
  }

  const snapshot = outcome.snapshot;
  if (snapshot !== undefined) {
    if (snapshot.text.length > maxSnapshotCharacters && artifacts !== undefined) {
      const artifact = await publishText(
        artifacts,
        snapshot.text,
        'text/plain',
        `${hostOf(outcome.url)}-snapshot.txt`,
      );
      published.push(artifact);
      summary.snapshotArtifactId = artifact.artifact.artifactId;
    }
    summary.snapshot = snapshot.text.slice(0, maxSnapshotCharacters);
    summary.snapshotTruncated = snapshot.text.length > maxSnapshotCharacters;
    if (snapshot.refs !== undefined) summary.refs = snapshot.refs;
    if (snapshot.hasMore === true) summary.snapshotNextOffset = snapshot.nextOffset;
  }

  return [{ text: stableStringify(summary), type: 'text' }, ...published];
}

function hostOf(url: string | undefined): string {
  if (url === undefined) return 'page';
  try {
    return new URL(url).hostname;
  } catch {
    return 'page';
  }
}

export { BROWSER_ACT_AUTHORITY, BROWSER_EVALUATE_AUTHORITY, BROWSER_READ_AUTHORITY, browserTools };
