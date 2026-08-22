import { describe, expect, it } from 'vitest'

import { renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  it('renders Markdown and highlights fenced programming languages', () => {
    const rendered = renderMarkdown(`**Result**

\`\`\`typescript
const answer: number = 42
\`\`\``)

    expect(rendered).toContain('<strong>Result</strong>')
    expect(rendered).toContain('class="language-typescript"')
    expect(rendered).toContain('<span class="hljs-keyword">const</span>')
    expect(rendered).toContain('<span class="hljs-number">42</span>')
  })

  it('recognizes framework and additional language fences', () => {
    const rendered = renderMarkdown(`\`\`\`vue
<script setup lang="ts">
const ready = true
</script>
\`\`\`

\`\`\`powershell
Write-Output "Nox"
\`\`\``)

    expect(rendered).toContain('class="language-vue"')
    expect(rendered).toContain('class="hljs-name"')
    expect(rendered).toContain('class="language-powershell"')
    expect(rendered).toContain('class="hljs-built_in"')
  })

  it('renders inline and display TeX with dollar and bracket delimiters', () => {
    const rendered = renderMarkdown(String.raw`Euler: $e^{i\pi}+1=0$ and \(x^2\).

\[
\frac{a}{b}
\]`)

    expect(rendered.match(/class="katex"/gu)).toHaveLength(3)
    expect(rendered).toContain("class='katex-block'")
    expect(rendered).toContain('encoding="application/x-tex"')
  })

  it('keeps raw HTML inert and hardens generated links', () => {
    const rendered = renderMarkdown(`<img src=x onerror=alert(1)>

[unsafe](javascript:alert(1))

[safe](https://example.com)`)
    const container = document.createElement('div')
    container.innerHTML = rendered

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
    const link = container.querySelector('a')
    expect(container.querySelectorAll('a')).toHaveLength(1)
    expect(link?.getAttribute('href')).toBe('https://example.com')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(link?.getAttribute('target')).toBe('_blank')
  })
})
