<script setup lang="ts">
import { computed, type DeepReadonly } from 'vue'

import { useI18n } from '@/shared/i18n'

import type { ChatMediaPart } from '../api/chat.schemas'
import type { ToolActivity } from '../stores/activeSession.store'

interface Props {
  item: DeepReadonly<ToolActivity>
}

const props = defineProps<Props>()
const { t } = useI18n()

const state = computed(() => {
  const response = props.item.responses[props.item.responses.length - 1]
  if (response === undefined) return t('chat.tool.running')
  if (response.isError) return t('chat.tool.failed')
  switch (response.execution) {
    case 'deferredAck':
      return t('chat.tool.deferred')
    case 'permissionPending':
      return t('chat.tool.awaitingPermission')
    case 'deferredResult':
    case 'immediate':
      return t('chat.tool.complete')
  }
  return t('chat.tool.running')
})

const tone = computed(() => {
  const response = props.item.responses[props.item.responses.length - 1]
  if (response?.isError === true) return 'error'
  if (response?.execution === 'deferredResult' || response?.execution === 'immediate') {
    return 'complete'
  }
  return 'active'
})

function responseLabel(
  execution: DeepReadonly<ToolActivity>['responses'][number]['execution'],
): string {
  switch (execution) {
    case 'deferredAck':
      return t('chat.tool.deferredAcknowledgment')
    case 'deferredResult':
      return t('chat.tool.deferredResult')
    case 'immediate':
      return t('chat.tool.result')
    case 'permissionPending':
      return t('chat.tool.permissionPending')
  }
}

function formatArguments(): string {
  return JSON.stringify(props.item.arguments ?? {}, undefined, 2)
}

function mediaUrl(part: ChatMediaPart): string {
  return part.source.type === 'url'
    ? part.source.url
    : `data:${part.source.mediaType};base64,${part.source.data}`
}
</script>

<template>
  <details class="tool" :class="`tool--${tone}`">
    <summary class="tool__header">
      <span class="tool__chevron" aria-hidden="true"></span>
      <span class="tool__identity">
        <span>{{ t('chat.tool.call') }}</span>
        <strong>{{ props.item.name }}</strong>
      </span>
      <span class="tool__state">{{ state }}</span>
    </summary>

    <div class="tool__body">
      <details v-if="props.item.arguments !== undefined" class="tool__nested">
        <summary>
          <span class="tool__chevron" aria-hidden="true"></span>
          <span>{{ t('chat.tool.arguments') }}</span>
        </summary>
        <pre>{{ formatArguments() }}</pre>
      </details>

      <ol v-if="props.item.responses.length > 0" class="tool__responses">
        <li v-for="response in props.item.responses" :key="response.id">
          <details
            class="tool__nested tool__result"
            :class="{ 'tool__result--error': response.isError }"
          >
            <summary>
              <span class="tool__chevron" aria-hidden="true"></span>
              <span>{{ responseLabel(response.execution) }}</span>
              <span>{{ response.isError ? t('chat.tool.error') : t('chat.tool.ok') }}</span>
            </summary>
            <pre v-if="response.text.length > 0">{{ response.text }}</pre>
            <div v-if="response.media.length > 0" class="tool__media">
              <template
                v-for="(part, index) in response.media"
                :key="`${part.type}-${String(index)}`"
              >
                <img
                  v-if="part.type === 'image'"
                  :src="mediaUrl(part)"
                  :alt="t('chat.tool.returnedImage')"
                  loading="lazy"
                />
                <audio
                  v-else-if="part.type === 'audio'"
                  :src="mediaUrl(part)"
                  controls
                  preload="metadata"
                ></audio>
                <video
                  v-else-if="part.type === 'video'"
                  :src="mediaUrl(part)"
                  controls
                  preload="metadata"
                ></video>
                <a v-else :href="mediaUrl(part)" target="_blank" rel="noopener noreferrer">
                  {{ t('chat.tool.openReturnedDocument') }}
                </a>
              </template>
            </div>
          </details>
        </li>
      </ol>
    </div>
  </details>
</template>

<style scoped lang="scss">
.tool {
  width: min(100%, 46rem);
  border: 1px solid var(--nox-border-subtle);
  border-inline-start: 2px solid var(--nox-status-info);
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-secondary);
  background: color-mix(in srgb, var(--nox-surface-1) 76%, transparent);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  overflow: hidden;
}

.tool--complete {
  border-inline-start-color: var(--nox-status-success);
}

.tool--error {
  border-inline-start-color: var(--nox-status-danger);
}

.tool__header {
  display: flex;
  min-height: 2.65rem;
  align-items: center;
  gap: var(--nox-space-3);
  padding: var(--nox-space-3) var(--nox-space-4);
  cursor: pointer;
  list-style: none;
}

.tool__header::-webkit-details-marker,
.tool__nested summary::-webkit-details-marker {
  display: none;
}

.tool__identity {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: var(--nox-space-3);
}

.tool__identity > span,
.tool__state {
  color: var(--nox-text-muted);
  font-size: 0.65rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.tool__identity strong {
  min-width: 0;
  color: var(--nox-status-info);
  font-size: var(--nox-text-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool__state {
  flex: 0 0 auto;
}

.tool--complete .tool__state {
  color: var(--nox-status-success);
}

.tool--error .tool__state {
  color: var(--nox-status-danger);
}

.tool__body {
  display: grid;
  gap: var(--nox-space-3);
  padding: var(--nox-space-3) var(--nox-space-4) var(--nox-space-4);
  border-top: 1px solid var(--nox-border-subtle);
}

.tool__chevron {
  width: 0.42rem;
  height: 0.42rem;
  flex: 0 0 auto;
  border-right: 1px solid currentColor;
  border-bottom: 1px solid currentColor;
  color: var(--nox-text-muted);
  transform: rotate(-45deg);
  transition: transform 120ms ease;
}

.tool[open] > .tool__header > .tool__chevron,
.tool__nested[open] > summary > .tool__chevron {
  transform: rotate(45deg) translate(-0.08rem, -0.08rem);
}

.tool__nested summary {
  display: flex;
  align-items: center;
  gap: var(--nox-space-2);
  color: var(--nox-text-muted);
  cursor: pointer;
  list-style: none;
}

.tool__nested pre {
  max-height: 14rem;
  margin: var(--nox-space-2) 0 0;
  padding: var(--nox-space-3);
  color: var(--nox-text-secondary);
  background: var(--nox-canvas);
  overflow: auto;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.tool__media {
  display: grid;
  gap: var(--nox-space-2);
  margin-top: var(--nox-space-2);
}

.tool__media img,
.tool__media video {
  width: 100%;
  max-height: 20rem;
  border: 1px solid var(--nox-border-subtle);
  object-fit: contain;
  background: var(--nox-canvas);
}

.tool__media audio {
  width: 100%;
}

.tool__media a {
  color: var(--nox-action-primary);
}

.tool__responses {
  display: grid;
  margin: 0;
  gap: var(--nox-space-2);
  padding: 0;
  list-style: none;
}

.tool__responses li {
  padding-top: var(--nox-space-2);
  border-top: 1px solid var(--nox-border-subtle);
}

.tool__result summary > span:nth-child(2) {
  min-width: 0;
  flex: 1;
}

.tool__result summary > span:last-child {
  color: var(--nox-status-success);
  font-size: 0.65rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.tool__result--error summary,
.tool__result--error summary > span:last-child,
.tool__result--error pre {
  color: var(--nox-status-danger);
}

@media (prefers-reduced-motion: reduce) {
  .tool__chevron {
    transition: none;
  }
}
</style>
