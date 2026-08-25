import type { BrowserInspection, BrowserRequest } from '../../capabilities';

/**
 * Fixed page-side routine used by every browser module.
 *
 * This is deliberately not caller-supplied JavaScript: browser_inspect remains
 * a read capability even when arbitrary evaluation is disabled. Keeping one
 * routine also means camoufox and Playwright suggest selectors by the same
 * rules.
 */
const INSPECT_FUNCTION = String.raw`function noxBrowserInspect(input) {
  const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
  const needle = normalize(input.text).toLocaleLowerCase();
  const exact = input.exact === true;
  const maxResults = Number.isInteger(input.maxResults) ? input.maxResults : 10;

  let candidates;
  try {
    candidates = Array.from(document.querySelectorAll(input.selector || 'body *'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error('Invalid CSS selector ' + String(input.selector) + ': ' + detail);
  }

  const matching = candidates.filter((element) => {
    if (!needle) return true;
    const content = normalize(element.textContent).toLocaleLowerCase();
    return exact ? content === needle : content.includes(needle);
  });

  // A text search otherwise returns html, body and every wrapper above the
  // useful node. Begin at the deepest match, then prefer a matching ancestor
  // with stronger evidence that it is the stable interactive container. This
  // turns text inside a site's unlabelled div button into that div's unique ID.
  const matchingSet = new Set(matching);
  const ancestors = new Set();
  for (const element of matching) {
    let parent = element.parentElement;
    while (parent) {
      if (matchingSet.has(parent)) ancestors.add(parent);
      parent = parent.parentElement;
    }
  }
  const candidateScore = (element) => {
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute('role');
    let score = 0;
    if (['a', 'button', 'input', 'select', 'summary', 'textarea'].includes(tag)) score += 100;
    if (role && ['button', 'checkbox', 'link', 'menuitem', 'option', 'radio', 'switch', 'tab'].includes(role)) score += 100;
    if (element.hasAttribute('onclick') || typeof element.onclick === 'function') score += 100;
    if (element.tabIndex >= 0) score += 80;
    if (element.id) score += 30;
    if (element.hasAttribute('data-test') || element.hasAttribute('data-testid')) score += 30;
    if (getComputedStyle(element).cursor === 'pointer') score += 10;
    return score;
  };
  const leaves = matching.filter((element) => !ancestors.has(element));
  const focused = input.selector
    ? matching
    : Array.from(
        new Set(
          leaves.map((leaf) => {
            let best = leaf;
            let bestScore = candidateScore(leaf);
            let parent = leaf.parentElement;
            while (parent && matchingSet.has(parent)) {
              const score = candidateScore(parent);
              if (score > bestScore) {
                best = parent;
                bestScore = score;
              }
              parent = parent.parentElement;
            }
            return best;
          }),
        ),
      );

  const uniqueSelector = (element) => {
    const escaped = (value) =>
      globalThis.CSS && typeof globalThis.CSS.escape === 'function'
        ? globalThis.CSS.escape(value)
        : value.replace(/[^a-zA-Z0-9_-]/g, (character) => '\\' + character);
    if (element.id) {
      const byId = '#' + escaped(element.id);
      if (document.querySelectorAll(byId).length === 1) return byId;
    }

    for (const name of ['data-testid', 'data-test', 'name']) {
      const value = element.getAttribute(name);
      if (!value) continue;
      const candidate = element.tagName.toLowerCase() + '[' + name + '="' + value.replace(/"/g, '\\"') + '"]';
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    }

    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
      let part = current.tagName.toLowerCase();
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter((sibling) => sibling.tagName === current.tagName)
        : [];
      if (siblings.length > 1) part += ':nth-of-type(' + String(siblings.indexOf(current) + 1) + ')';
      parts.unshift(part);
      const candidate = parts.join(' > ');
      if (document.querySelectorAll(candidate).length === 1) return candidate;
      current = current.parentElement;
    }
    return parts.join(' > ');
  };

  const describe = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const visible =
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity) > 0 &&
      rect.width > 0 &&
      rect.height > 0;
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute('role');
    const signals = [];
    if (['a', 'button', 'input', 'select', 'summary', 'textarea'].includes(tag)) signals.push('semantic element');
    if (role && ['button', 'checkbox', 'link', 'menuitem', 'option', 'radio', 'switch', 'tab'].includes(role)) signals.push('interactive role');
    if (element.hasAttribute('onclick') || typeof element.onclick === 'function') signals.push('click handler');
    if (element.tabIndex >= 0) signals.push('keyboard focus');
    if (style.cursor === 'pointer') signals.push('pointer cursor');

    const attributes = {};
    for (const name of ['aria-label', 'data-test', 'data-testid', 'href', 'name', 'title', 'type']) {
      const value = element.getAttribute(name);
      if (value) attributes[name] = value.slice(0, 500);
    }
    const text = normalize(element.innerText || element.textContent).slice(0, 500);
    const classes = Array.from(element.classList).slice(0, 20);

    return {
      ...(Object.keys(attributes).length ? { attributes } : {}),
      ...(visible
        ? {
            box: {
              height: Math.round(rect.height),
              width: Math.round(rect.width),
              x: Math.round(rect.x),
              y: Math.round(rect.y),
            },
          }
        : {}),
      ...(classes.length ? { classes } : {}),
      ...(element.id ? { id: element.id } : {}),
      interactive: signals.length > 0,
      ...(signals.length ? { interactionSignals: signals } : {}),
      ...(role ? { role } : {}),
      selector: uniqueSelector(element),
      tag,
      ...(text ? { text } : {}),
      visible,
    };
  };

  const described = focused.map(describe).sort((left, right) => {
    if (left.visible !== right.visible) return left.visible ? -1 : 1;
    if (left.interactive !== right.interactive) return left.interactive ? -1 : 1;
    return 0;
  });
  return {
    matches: described.slice(0, maxResults),
    total: described.length,
    truncated: described.length > maxResults,
  };
}`;

/** An expression with arguments encoded as data, never interpolated as code. */
function inspectionExpression(request: BrowserRequest): string {
  const input = JSON.stringify({
    exact: request.exact ?? false,
    maxResults: request.maxResults ?? 10,
    selector: request.selector,
    text: request.text,
  });
  return `(${INSPECT_FUNCTION})(${input})`;
}

/** Refuse a page/service response that is not the fixed routine's result. */
function inspectionResult(value: unknown): BrowserInspection {
  if (typeof value !== 'object' || value === null) {
    throw new Error('The browser returned no inspection result.');
  }
  const result = value as Partial<BrowserInspection>;
  if (
    !Array.isArray(result.matches) ||
    typeof result.total !== 'number' ||
    !Number.isInteger(result.total) ||
    typeof result.truncated !== 'boolean'
  ) {
    throw new Error('The browser returned a malformed inspection result.');
  }
  return result as BrowserInspection;
}

export { inspectionExpression, inspectionResult };
