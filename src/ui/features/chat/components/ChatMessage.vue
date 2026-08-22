<script setup lang="ts">
import { computed } from 'vue'

import { renderMarkdown } from '../model/markdown'

import type { AssistantItem, UserItem } from '../stores/activeSession.store'

interface Props {
  item: AssistantItem | UserItem
}

const props = defineProps<Props>()
const renderedMessage = computed(() => renderMarkdown(props.item.text))
const streaming = computed(() => props.item.kind === 'assistant' && props.item.streaming)
const timestamp = computed(() =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(props.item.createdAt)),
)
</script>

<template>
  <article class="message" :class="`message--${props.item.kind}`">
    <header class="message__author">{{ props.item.kind === 'user' ? 'YOU' : 'NOX' }}</header>
    <!-- markdown.ts escapes raw HTML and only emits HTML from trusted renderers. -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div
      class="message__text"
      :class="{ 'message__text--streaming': streaming }"
      :aria-busy="streaming"
      v-html="renderedMessage"
    ></div>
    <time class="message__timestamp" :datetime="props.item.createdAt" :title="props.item.createdAt">
      {{ timestamp }}
    </time>
  </article>
</template>

<style scoped lang="scss">
.message {
  display: grid;
  width: min(100%, 46rem);
  min-width: 0;
  gap: var(--nox-space-2);
}

.message--assistant {
  justify-self: start;
  padding: var(--nox-space-5) var(--nox-space-6);
  border: 1px solid var(--nox-border-subtle);
  border-left: 2px solid var(--nox-action-primary);
  border-radius: var(--nox-radius-panel) var(--nox-radius-panel) var(--nox-radius-panel) 0;
  background: var(--nox-surface-1);
}

.message--user {
  justify-self: end;
  width: min(88%, 38rem);
  padding: var(--nox-space-4) var(--nox-space-5);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-panel) var(--nox-radius-panel) 0 var(--nox-radius-panel);
  background: var(--nox-surface-2);
}

.message__author {
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  font-weight: 700;
  letter-spacing: var(--nox-tracking-system);
}

.message--assistant .message__author {
  color: var(--nox-action-primary);
}

.message__timestamp {
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: 0.65rem;
  letter-spacing: 0.04em;
}

.message--user .message__timestamp {
  text-align: right;
}

.message__text {
  min-width: 0;
  color: var(--nox-text-primary);
  line-height: var(--nox-leading-body);
  overflow-wrap: anywhere;
}

.message__text :deep(> :first-child) {
  margin-top: 0;
}

.message__text :deep(> :last-child) {
  margin-bottom: 0;
}

.message__text :deep(p) {
  margin: 0 0 var(--nox-space-4);
}

.message__text :deep(h1),
.message__text :deep(h2),
.message__text :deep(h3),
.message__text :deep(h4) {
  margin: var(--nox-space-6) 0 var(--nox-space-3);
  line-height: var(--nox-leading-tight);
}

.message__text :deep(h1) {
  font-size: var(--nox-text-xl);
}

.message__text :deep(h2) {
  font-size: 1.45rem;
}

.message__text :deep(h3),
.message__text :deep(h4) {
  font-size: var(--nox-text-lg);
}

.message__text :deep(ul),
.message__text :deep(ol) {
  padding-left: var(--nox-space-6);
  margin: 0 0 var(--nox-space-4);
}

.message__text :deep(li + li) {
  margin-top: var(--nox-space-1);
}

.message__text :deep(a) {
  color: var(--nox-action-primary);
  text-decoration-thickness: 0.08em;
  text-underline-offset: 0.18em;
}

.message__text :deep(a:hover) {
  color: var(--nox-action-primary-hover);
}

.message__text :deep(blockquote) {
  padding-left: var(--nox-space-4);
  border-left: 3px solid var(--nox-border-strong);
  margin: 0 0 var(--nox-space-4);
  color: var(--nox-text-secondary);
}

.message__text :deep(hr) {
  border: 0;
  border-top: 1px solid var(--nox-border-subtle);
  margin: var(--nox-space-6) 0;
}

.message__text :deep(code) {
  font-family: var(--nox-font-mono);
  font-size: 0.9em;
}

.message__text :deep(:not(pre) > code) {
  padding: 0.12em 0.35em;
  border: 1px solid var(--nox-border-subtle);
  border-radius: 0.3rem;
  background: var(--nox-surface-input);
  color: var(--nox-code-inline);
}

.message__text :deep(pre) {
  max-width: 100%;
  padding: var(--nox-space-4) var(--nox-space-5);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-panel);
  margin: 0 0 var(--nox-space-4);
  background: var(--nox-surface-input);
  overflow-x: auto;
  overflow-wrap: normal;
  scrollbar-color: var(--nox-border-strong) transparent;
  white-space: pre;
}

.message__text :deep(pre code) {
  color: var(--nox-text-primary);
}

.message__text :deep(table) {
  display: block;
  max-width: 100%;
  border-collapse: collapse;
  margin: 0 0 var(--nox-space-4);
  overflow-x: auto;
}

.message__text :deep(th),
.message__text :deep(td) {
  padding: var(--nox-space-2) var(--nox-space-3);
  border: 1px solid var(--nox-border-subtle);
  text-align: left;
}

.message__text :deep(th) {
  background: var(--nox-surface-2);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-sm);
}

.message__text :deep(.hljs-comment),
.message__text :deep(.hljs-quote) {
  color: var(--nox-code-comment);
  font-style: italic;
}

.message__text :deep(.hljs-keyword),
.message__text :deep(.hljs-selector-tag),
.message__text :deep(.hljs-type) {
  color: var(--nox-code-keyword);
}

.message__text :deep(.hljs-title),
.message__text :deep(.hljs-section),
.message__text :deep(.hljs-name),
.message__text :deep(.hljs-selector-id),
.message__text :deep(.hljs-selector-class),
.message__text :deep(.hljs-selector-pseudo) {
  color: var(--nox-code-name);
}

.message__text :deep(.hljs-number),
.message__text :deep(.hljs-literal),
.message__text :deep(.hljs-boolean) {
  color: var(--nox-code-literal);
}

.message__text :deep(.hljs-string),
.message__text :deep(.hljs-regexp),
.message__text :deep(.hljs-attribute),
.message__text :deep(.hljs-doctag) {
  color: var(--nox-code-string);
}

.message__text :deep(.hljs-built_in),
.message__text :deep(.hljs-symbol),
.message__text :deep(.hljs-bullet),
.message__text :deep(.hljs-meta) {
  color: var(--nox-code-symbol);
}

.message__text :deep(.hljs-variable),
.message__text :deep(.hljs-template-variable),
.message__text :deep(.hljs-attr) {
  color: var(--nox-code-variable);
}

.message__text :deep(.hljs-addition) {
  color: var(--nox-status-success);
}

.message__text :deep(.hljs-deletion) {
  color: var(--nox-status-danger);
}

.message__text :deep(.hljs-emphasis) {
  font-style: italic;
}

.message__text :deep(.hljs-strong) {
  font-weight: 700;
}

.message__text :deep(.katex) {
  font-size: 1.05em;
}

.message__text :deep(.katex-block) {
  max-width: 100%;
  padding: var(--nox-space-3) 0;
  margin: 0 0 var(--nox-space-4);
  overflow-x: auto;
  overflow-y: hidden;
}

.message__text :deep(.katex-display) {
  margin: 0;
}

.message__text :deep(.katex-error) {
  color: var(--nox-status-danger) !important;
  font-family: var(--nox-font-mono);
}

.message__text--streaming :deep(> :last-child)::after,
.message__text--streaming:empty::after {
  display: inline-block;
  width: 0.55rem;
  height: 1em;
  margin-left: var(--nox-space-1);
  background: var(--nox-action-primary);
  content: '';
  vertical-align: -0.12em;
  animation: blink 1s steps(2, jump-none) infinite;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .message__text--streaming :deep(> :last-child)::after,
  .message__text--streaming:empty::after {
    animation: none;
  }
}
</style>
