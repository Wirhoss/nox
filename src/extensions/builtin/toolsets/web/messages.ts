const englishMessages = Object.freeze({
  'toolSet.description':
    'Search the public web, extract pages as durable files, and drive a real browser.',
  'toolSet.name': 'Web tools',
  'tools.browser_click.description':
    'Click an element on an open page and return the page after it.',
  'tools.browser_close.description': 'Close an open tab.',
  'tools.browser_evaluate.description':
    'Run arbitrary JavaScript in an open page when explicitly enabled.',
  'tools.browser_images.description': 'List the images an open page points at.',
  'tools.browser_inspect.description':
    'Find DOM elements and report selectors and interaction signals.',
  'tools.browser_links.description': 'List the links an open page points at.',
  'tools.browser_navigate.description': 'Point an open tab at another URL.',
  'tools.browser_open.description': 'Open a browser tab and return its tabId with the page.',
  'tools.browser_press.description': 'Press one key on an open page.',
  'tools.browser_screenshot.description': 'Capture an open page as an image artifact.',
  'tools.browser_scroll.description': 'Scroll an open page.',
  'tools.browser_snapshot.description':
    'Read an open page as an accessibility snapshot with element refs.',
  'tools.browser_type.description': 'Type text into an element on an open page.',
  'tools.browser_wait.description': 'Wait for an element or a delay on an open page.',
  'tools.web_extract.description':
    'Extract public web pages as durable files — cleaned HTML, the page images, and optionally a screenshot, PDF or Markdown.',
  'tools.web_search.description':
    'Search the public web and return result titles, URLs, and snippets.',
  'ui.browser.enableEvaluate': 'Enable arbitrary JavaScript evaluation',
  'ui.browser.enableEvaluateHelp':
    'Opt in to browser_evaluate. Page JavaScript can read storage, make requests and modify the page, and requires its own authority.',
  'ui.camoufox.snapshot': 'Inline snapshot characters',
  'ui.camoufox.snapshotHelp':
    'Longer accessibility snapshots are published as a file and only their head stays in the conversation.',
  'ui.camoufox.userId': 'Browser session owner',
  'ui.camoufox.userIdHelp': 'The camofox user this Nox instance browses as.',
  'ui.crawl4ai.captures': 'Default captures',
  'ui.crawl4ai.capturesHelp':
    'What each page returns when the agent does not ask for something else.',
  'ui.crawl4ai.waitUntil': 'Wait until',
  'ui.crawl4ai.waitUntilHelp': 'How settled a page must be before it is captured.',
  'ui.credential': 'Credential',
  'ui.credentialHelp':
    'The managed secret holding this service’s token. Values are never read back.',
  'ui.defaultResults': 'Default results',
  'ui.maximumResults': 'Maximum results',
  'ui.maximumUrls': 'Maximum URLs per call',
  'ui.playwright.browser': 'Browser engine',
  'ui.playwright.browserHelp':
    'Chromium, Firefox or WebKit. The local container includes Chromium; the others need a remote endpoint.',
  'ui.playwright.credentialHelp':
    'Optional bearer token sent only when connecting to a remote Playwright endpoint.',
  'ui.playwright.executablePath': 'Browser executable',
  'ui.playwright.executablePathHelp':
    'Optional local browser executable. Empty uses the container Chromium or a browser installed by Playwright.',
  'ui.playwright.headless': 'Headless',
  'ui.playwright.headlessHelp': 'Run a locally launched browser without a visible window.',
  'ui.playwright.snapshot': 'Inline snapshot characters',
  'ui.playwright.snapshotHelp':
    'Longer accessibility snapshots are published as a file and only their head stays in the conversation.',
  'ui.playwright.wsEndpoint': 'Playwright WebSocket endpoint',
  'ui.playwright.wsEndpointHelp':
    'Optional ws:// or wss:// endpoint from browserType.launchServer. Empty launches locally.',
  'ui.searxng.engines': 'Engines',
  'ui.searxng.enginesHelp': 'Comma-separated SearXNG engines. Empty uses the instance’s own set.',
  'ui.searxng.language': 'Default language',
  'ui.searxng.languageHelp': 'SearXNG language code such as en, es, or all.',
  'ui.searxng.safeSearch': 'Safe search',
  'ui.searxng.safeSearchHelp': '0 off, 1 moderate, 2 strict.',
  'ui.serviceUrl': 'Service URL',
  'ui.slot.browser': 'Browser',
  'ui.slot.browserHelp': 'Fills this slot to expose the browser tool.',
  'ui.slot.extract': 'Extraction',
  'ui.slot.extractHelp': 'Fills this slot to expose web_extract.',
  'ui.slot.search': 'Search',
  'ui.slot.searchHelp': 'Fills this slot to expose web_search.',
  'ui.timeout': 'Timeout (ms)',
} as const);

export { englishMessages };
