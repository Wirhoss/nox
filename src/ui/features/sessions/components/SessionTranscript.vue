<script setup lang="ts">
import { useI18n } from '@/shared/i18n'

import type { SessionTranscriptEntry } from '../api/sessions.api'
import type { ChatContentPart } from '@/features/chat/api/chat.schemas'

interface Props {
  entries: readonly SessionTranscriptEntry[]
}

const props = defineProps<Props>()
const { formatDate, t } = useI18n()

function textOf(parts: readonly ChatContentPart[]): string {
  return parts
    .map((part) => {
      if (part.type === 'text') return part.text
      if (part.type === 'artifact') return `[${part.artifact.filename ?? part.artifact.artifactId}]`
      return `[${part.type}: ${part.source.url}]`
    })
    .join('\n')
}

function moment(value: string): string {
  return formatDate(value, { dateStyle: 'medium', timeStyle: 'short' })
}
</script>

<template>
  <ol class="transcript" :aria-label="t('sessions.transcript.label')">
    <li
      v-for="entry in props.entries"
      :key="entry.messageId"
      class="transcript__entry"
      :class="`transcript__entry--${entry.role}`"
    >
      <header>
        <strong>{{ t(`sessions.transcript.role.${entry.role}`) }}</strong>
        <time :datetime="entry.createdAt">{{ moment(entry.createdAt) }}</time>
      </header>

      <template v-if="entry.role === 'toolCall'">
        <p class="transcript__tool">{{ entry.name }}</p>
        <pre>{{ JSON.stringify(entry.arguments, undefined, 2) }}</pre>
      </template>
      <template v-else-if="entry.role === 'toolResponse'">
        <p class="transcript__tool" :class="{ 'transcript__tool--error': entry.isError === true }">
          {{ entry.name }} ·
          {{ entry.isError === true ? t('sessions.transcript.failed') : t('sessions.transcript.complete') }}
        </p>
        <p>{{ textOf(entry.response) }}</p>
      </template>
      <template v-else>
        <p>{{ textOf(entry.content) }}</p>
      </template>
    </li>
  </ol>
</template>

<style scoped lang="scss">
.transcript {
  display: grid;
  width: min(100%, 58rem);
  gap: var(--nox-space-4);
  margin: 0 auto;
  padding: var(--nox-space-6);
  list-style: none;
}

.transcript__entry {
  display: grid;
  gap: var(--nox-space-3);
  padding: var(--nox-space-4) var(--nox-space-5);
  border: 1px solid var(--nox-border-subtle);
  border-inline-start: 2px solid var(--nox-border-strong);
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-secondary);
  background: color-mix(in srgb, var(--nox-surface-1) 90%, transparent);
}

.transcript__entry--user {
  border-inline-start-color: var(--nox-action-primary);
}

.transcript__entry--assistant {
  border-inline-start-color: var(--nox-status-info);
}

.transcript__entry--reasoning,
.transcript__entry--compacted,
.transcript__entry--folded {
  opacity: 0.72;
}

.transcript__entry--toolCall,
.transcript__entry--toolResponse {
  margin-inline: var(--nox-space-6);
  border-inline-start-color: var(--nox-status-warning);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.transcript__entry header {
  display: flex;
  justify-content: space-between;
  gap: var(--nox-space-4);
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.transcript__entry p {
  margin: 0;
  line-height: var(--nox-leading-body);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.transcript__entry pre {
  max-height: 16rem;
  margin: 0;
  padding: var(--nox-space-3);
  color: var(--nox-code-inline);
  background: var(--nox-canvas);
  overflow: auto;
  white-space: pre-wrap;
}

.transcript__tool {
  color: var(--nox-status-info);
}

.transcript__tool--error {
  color: var(--nox-status-danger);
}

@media (max-width: 42rem) {
  .transcript {
    padding: var(--nox-space-4);
  }

  .transcript__entry--toolCall,
  .transcript__entry--toolResponse {
    margin-inline: 0;
  }
}
</style>
