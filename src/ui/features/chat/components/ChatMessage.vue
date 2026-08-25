<script setup lang="ts">
import { computed, type DeepReadonly, ref } from 'vue'

import { useI18n } from '@/shared/i18n'

import { renderMarkdown } from '../model/markdown'
import ArtifactMedia from './ArtifactMedia.vue'
import RunActivityCard from './RunActivityCard.vue'

import type { ChatContentPart } from '../api/chat.schemas'
import type { AssistantItem, RunActivityItem, UserItem } from '../stores/activeSession.store'

interface Props {
  activity?: DeepReadonly<RunActivityItem>
  embedded?: boolean
  item: AssistantItem | UserItem
  showAuthor?: boolean
  showTimestamp?: boolean
}

const props = withDefaults(defineProps<Props>(), { showAuthor: true, showTimestamp: true })
const { formatDate, t } = useI18n()
const detailsOpen = ref(false)
const hasDetails = computed(() => props.item.kind === 'assistant' && props.activity !== undefined)
const streaming = computed(() => props.item.kind === 'assistant' && props.item.streaming)
const assistantContent = computed<readonly ChatContentPart[]>(() => {
  if (props.item.kind !== 'assistant') return []
  if (props.item.content !== undefined) return props.item.content
  return [
    ...props.item.media,
    ...(props.item.text.length === 0 ? [] : [{ text: props.item.text, type: 'text' as const }]),
  ]
})
const lastAssistantTextIndex = computed(() => {
  for (let index = assistantContent.value.length - 1; index >= 0; index -= 1) {
    if (assistantContent.value[index]?.type === 'text') return index
  }
  return -1
})

const timestamp = computed(() =>
  formatDate(props.item.createdAt, { dateStyle: 'medium', timeStyle: 'short' }),
)
</script>

<template>
  <article
    class="message"
    :class="[`message--${props.item.kind}`, { 'message--embedded': props.embedded === true }]"
  >
    <header v-if="props.showAuthor" class="message__author">
      {{ props.item.kind === 'user' ? t('chat.message.you') : 'NOX' }}
    </header>
    <div v-if="props.item.kind === 'assistant'" class="message__content">
      <template v-for="(part, index) in assistantContent" :key="`${part.type}-${String(index)}`">
        <!-- markdown.ts escapes raw HTML and only emits HTML from trusted renderers. -->
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div
          v-if="part.type === 'text'"
          class="message__text"
          :class="{
            'message__text--streaming': streaming && index === lastAssistantTextIndex,
          }"
          :aria-busy="streaming && index === lastAssistantTextIndex"
          v-html="renderMarkdown(part.text)"
        ></div>
        <div v-else class="message__media message__media--inline">
          <ArtifactMedia :part="part" />
        </div>
      </template>
    </div>

    <template v-else>
      <div v-if="props.item.media.length > 0" class="message__media">
        <ArtifactMedia
          v-for="(part, index) in props.item.media"
          :key="`${part.type}-${String(index)}`"
          :part="part"
        />
      </div>
      <!-- markdown.ts escapes raw HTML and only emits HTML from trusted renderers. -->
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div class="message__text" v-html="renderMarkdown(props.item.text)"></div>
    </template>
    <footer v-if="props.showTimestamp || hasDetails" class="message__footer">
      <time
        v-if="props.showTimestamp"
        class="message__timestamp"
        :datetime="props.item.createdAt"
        :title="props.item.createdAt"
      >
        {{ timestamp }}
      </time>

      <button
        v-if="hasDetails"
        class="message__details-summary"
        type="button"
        :aria-controls="`run-details-${props.item.id}`"
        :aria-expanded="detailsOpen"
        @click="detailsOpen = !detailsOpen"
      >
        <span
          class="message__details-chevron"
          :class="{ 'message__details-chevron--open': detailsOpen }"
          aria-hidden="true"
        ></span>
        <span>{{ t('common.details') }}</span>
      </button>

      <div
        v-if="hasDetails && detailsOpen"
        :id="`run-details-${props.item.id}`"
        class="message__details-body"
      >
        <RunActivityCard v-if="props.activity !== undefined" embedded :item="props.activity" />
      </div>
    </footer>
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
  border-inline-start: 2px solid var(--nox-action-primary);
  border-radius: var(--nox-radius-panel);
  border-end-start-radius: 0;
  background: var(--nox-surface-1);
}

.message--embedded.message--assistant {
  width: 100%;
  padding: var(--nox-space-5) var(--nox-space-6);
  border: 0;
  border-radius: 0;
  background: transparent;
}

.message--user {
  justify-self: end;
  width: min(88%, 38rem);
  padding: var(--nox-space-4) var(--nox-space-5);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-panel);
  border-end-end-radius: 0;
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

.message__footer {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
}

.message__timestamp {
  z-index: 1;
  grid-column: 1;
  grid-row: 1;
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: 0.65rem;
  letter-spacing: 0.04em;
}

.message--user .message__timestamp {
  grid-column: 1 / -1;
  text-align: end;
}

.message__details-summary {
  display: flex;
  width: max-content;
  grid-column: 2;
  grid-row: 1;
  align-items: center;
  gap: var(--nox-space-2);
  padding: 0;
  border: 0;
  margin-inline-start: auto;
  color: var(--nox-text-muted);
  background: transparent;
  cursor: pointer;
  font-family: var(--nox-font-mono);
  font-size: 0.65rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.message__details-chevron {
  width: 0.38rem;
  height: 0.38rem;
  border-right: 1px solid currentcolor;
  border-bottom: 1px solid currentcolor;
  transform: rotate(-45deg);
  transition: transform 120ms ease;
}

.message__details-chevron--open {
  transform: rotate(45deg) translate(-0.08rem, -0.08rem);
}

.message__details-body {
  display: grid;
  min-width: 0;
  grid-column: 1 / -1;
  grid-row: 2;
  gap: var(--nox-space-5);
  padding-top: var(--nox-space-4);
  border-top: 1px solid var(--nox-border-subtle);
  margin-top: var(--nox-space-4);
}

@media (prefers-reduced-motion: reduce) {
  .message__details-chevron {
    transition: none;
  }
}

.message__content {
  display: grid;
  min-width: 0;
  gap: var(--nox-space-2);
}

.message__media {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(14rem, 100%), 1fr));
  gap: var(--nox-space-3);
}

.message__media :deep(.artifact--image),
.message__media :deep(.artifact--video) {
  display: block;
  width: 100%;
  max-height: 28rem;
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  object-fit: contain;
  background: var(--nox-canvas);
}

.message__media :deep(.artifact--audio) {
  width: 100%;
}

.message__media--inline {
  grid-template-columns: minmax(0, 1fr);
}

.message__media :deep(.artifact--document) {
  color: var(--nox-action-primary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-sm);
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
  padding-inline-start: var(--nox-space-6);
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
  padding-inline-start: var(--nox-space-4);
  border-inline-start: 3px solid var(--nox-border-strong);
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
  text-align: start;
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
  margin-inline-start: var(--nox-space-1);
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
