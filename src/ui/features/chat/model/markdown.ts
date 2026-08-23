import { katex } from '@mdit/plugin-katex'
import hljs from 'highlight.js/lib/common'
import dart from 'highlight.js/lib/languages/dart'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import powershell from 'highlight.js/lib/languages/powershell'
import MarkdownIt from 'markdown-it'

import 'katex/dist/katex.min.css'

hljs.registerLanguage('dart', dart)
hljs.registerLanguage('dockerfile', dockerfile)
hljs.registerLanguage('powershell', powershell)
hljs.registerAliases(['astro', 'svelte', 'vue'], { languageName: 'xml' })

function highlightCode(source: string, language: string): string {
  const normalizedLanguage = language.toLowerCase()
  if (normalizedLanguage.length === 0 || hljs.getLanguage(normalizedLanguage) === undefined)
    return ''

  return hljs.highlight(source, {
    ignoreIllegals: true,
    language: normalizedLanguage,
  }).value
}

const markdown = new MarkdownIt({
  breaks: true,
  highlight: highlightCode,
  html: false,
  linkify: true,
  typographer: true,
}).use(katex, {
  delimiters: 'all',
  logger: () => 'ignore' as const,
  mathFence: true,
  maxExpand: 1_000,
  maxSize: 20,
  throwOnError: false,
  trust: false,
})

const defaultLinkOpen = markdown.renderer.rules.link_open
markdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
  const token = tokens[index]
  if (token === undefined) return ''

  token.attrSet('rel', 'noopener noreferrer')
  token.attrSet('target', '_blank')

  return defaultLinkOpen === undefined
    ? renderer.renderToken(tokens, index, options)
    : defaultLinkOpen(tokens, index, options, environment, renderer)
}

function renderMarkdown(source: string): string {
  return markdown.render(source)
}

export { renderMarkdown }
