<script setup lang="ts">
import { computed, ref } from 'vue'

import { useI18n } from '@/shared/i18n'
import { NoxButton } from '@/shared/ui/NoxButton'

import { useActiveSessionStore } from '../stores/activeSession.store'

const session = useActiveSessionStore()
const { t } = useI18n()
const conversations = computed(() => session.conversations)
const query = ref('')
const filteredConversations = computed(() => {
  const normalizedQuery = query.value.trim().toLocaleLowerCase()
  if (normalizedQuery.length === 0) return conversations.value

  return conversations.value.filter((conversation) =>
    [conversation.title, conversation.agentId, conversation.conversationId].some(
      (value) => value?.toLocaleLowerCase().includes(normalizedQuery) ?? false,
    ),
  )
})

function shortId(value: string): string {
  return value.slice(-8).toUpperCase()
}

function relativeTime(value: string): string {
  const elapsedMinutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000))
  if (elapsedMinutes < 1) return t('chat.conversation.now')
  if (elapsedMinutes < 60) return t('chat.conversation.minutesShort', { count: elapsedMinutes })
  const hours = Math.round(elapsedMinutes / 60)
  if (hours < 24) return t('chat.conversation.hoursShort', { count: hours })
  return t('chat.conversation.daysShort', { count: Math.round(hours / 24) })
}
</script>

<template>
  <section class="conversations" aria-labelledby="recent-conversations-title">
    <header>
      <h2 id="recent-conversations-title">{{ t('chat.conversation.plural') }}</h2>
      <span>{{ conversations.length }}</span>
    </header>

    <NoxButton block variant="secondary" @click="session.newConversation()">
      + {{ t('chat.conversation.new') }}
    </NoxButton>

    <label class="conversations__search">
      <span>{{ t('chat.conversation.find') }}</span>
      <svg aria-hidden="true" viewBox="0 0 20 20">
        <circle cx="8.5" cy="8.5" r="5.5" />
        <path d="m12.5 12.5 4 4" />
      </svg>
      <input
        v-model="query"
        type="search"
        :disabled="session.catalog.type !== 'ready' || conversations.length === 0"
        :placeholder="t('chat.conversation.searchPlaceholder')"
      />
    </label>

    <p v-if="session.catalog.type === 'loading'" class="conversations__state">
      {{ t('chat.conversation.scanning') }}
    </p>
    <p v-else-if="session.catalog.type === 'failed'" class="conversations__state">
      {{ session.catalog.message }}
    </p>
    <p v-else-if="conversations.length === 0" class="conversations__state">
      {{ t('chat.conversation.none') }}
    </p>
    <p v-else-if="filteredConversations.length === 0" class="conversations__state">
      {{ t('chat.conversation.noMatches') }}
    </p>

    <ol v-else>
      <li v-for="conversation in filteredConversations" :key="conversation.conversationId">
        <button
          type="button"
          :class="{
            'conversations__item--active': conversation.conversationId === session.conversationId,
          }"
          :aria-current="
            conversation.conversationId === session.conversationId ? 'page' : undefined
          "
          @click="session.openConversation(conversation.conversationId)"
        >
          <span class="conversations__identity">
            <strong>{{ conversation.title ?? conversation.agentId }}</strong>
            <small>
              {{
                conversation.title === undefined
                  ? shortId(conversation.conversationId)
                  : `${conversation.agentId} // ${shortId(conversation.conversationId)}`
              }}
            </small>
          </span>
          <span class="conversations__meta">
            <i :class="`conversations__signal--${conversation.state}`"></i>
            {{ relativeTime(conversation.updatedAt) }}
          </span>
        </button>
      </li>
    </ol>
  </section>
</template>

<style scoped lang="scss">
.conversations {
  display: grid;
  height: 100%;
  min-height: 0;
  grid-template-rows: auto auto auto minmax(0, 1fr);
  gap: var(--nox-space-3);
}

.conversations > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
}

.conversations h2 {
  margin: 0;
  font-size: 0.65rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.conversations > header span {
  font-size: var(--nox-text-xs);
}

.conversations__search {
  position: relative;
  display: flex;
  align-items: center;
}

.conversations__search > span {
  position: absolute;
  width: 1px;
  height: 1px;
  clip-path: inset(50%);
  overflow: hidden;
  white-space: nowrap;
}

.conversations__search svg {
  position: absolute;
  top: 50%;
  inset-inline-start: var(--nox-space-3);
  width: 1rem;
  height: 1rem;
  color: var(--nox-text-muted);
  fill: none;
  pointer-events: none;
  stroke: currentcolor;
  stroke-linecap: round;
  stroke-width: 1.5;
  transform: translateY(-50%);
}

.conversations__search input {
  width: 100%;
  height: var(--nox-control-height);
  padding-inline: 2.25rem var(--nox-space-3);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  outline: 0;
  color: var(--nox-text-primary);
  background: var(--nox-surface-input);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.conversations__search input::placeholder {
  color: var(--nox-text-muted);
}

.conversations__search input:hover:not(:disabled) {
  border-color: var(--nox-border-strong);
}

.conversations__search input:focus {
  border-color: var(--nox-action-primary);
  box-shadow: 0 0 0 1px var(--nox-action-primary);
}

.conversations__search input:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.conversations ol {
  display: grid;
  min-height: 0;
  align-content: start;
  grid-auto-rows: max-content;
  margin: 0;
  gap: var(--nox-space-1);
  padding: 0;
  list-style: none;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-color: var(--nox-border-strong) transparent;
}

.conversations li > button {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-2);
  padding: var(--nox-space-2) var(--nox-space-3);
  border: 1px solid transparent;
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-secondary);
  background: transparent;
  font-family: var(--nox-font-mono);
  text-align: start;
  cursor: pointer;
}

.conversations li > button:hover,
.conversations__item--active {
  border-color: var(--nox-border-subtle);
  background: var(--nox-surface-1);
}

.conversations__item--active {
  box-shadow: inset 2px 0 var(--nox-action-primary);
}

.conversations__identity {
  display: grid;
  min-width: 0;
}

.conversations__identity strong {
  color: var(--nox-text-primary);
  font-size: var(--nox-text-xs);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conversations__identity small,
.conversations__meta,
.conversations__state {
  color: var(--nox-text-muted);
  font-size: 0.62rem;
}

.conversations__identity small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conversations__meta {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--nox-space-1);
  font-style: normal;
}

.conversations__meta i {
  width: 0.38rem;
  height: 0.38rem;
  border-radius: 50%;
  background: var(--nox-text-muted);
}

.conversations__meta .conversations__signal--idle {
  background: var(--nox-status-success);
}

.conversations__meta .conversations__signal--running {
  background: var(--nox-status-warning);
}

.conversations__state {
  margin: 0;
  line-height: var(--nox-leading-body);
}

.conversations > .conversations__state {
  align-self: start;
}
</style>
