import { describe, expect, test } from 'bun:test';

import { renderMarkdown } from './markdown';

describe('chat Markdown renderer', () => {
  test('renders structured Markdown and hard line breaks', () => {
    const html = renderMarkdown('# Result\n\n- one\n- two\n\nfirst\nsecond\n\n```ts\nconst ready = true;\n```');

    expect(html).toContain('<h1>Result</h1>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('first<br>\nsecond');
    expect(html).toContain('<code class="language-ts">');
  });

  test('escapes raw HTML and rejects unsafe links and Markdown images', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))\n\n![tracker](https://example.com/pixel.gif)');

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<img');
  });

  test('opens validated links without opener access', () => {
    const html = renderMarkdown('[Nox](https://example.com)');

    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
  });
});
