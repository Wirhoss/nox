<script setup lang="ts">
import { computed } from 'vue'

import { NoxButton } from '@/shared/ui/NoxButton'

import { useActiveSessionStore } from '../stores/activeSession.store'

const session = useActiveSessionStore()
const conversations = computed(() => session.conversations)

function shortId(value: string): string {
  return value.slice(-8).toUpperCase()
}

function relativeTime(value: string): string {
  const elapsedMinutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000))
  if (elapsedMinutes < 1) return 'now'
  if (elapsedMinutes < 60) return `${String(elapsedMinutes)}m`
  const hours = Math.round(elapsedMinutes / 60)
  if (hours < 24) return `${String(hours)}h`
  return `${String(Math.round(hours / 24))}d`
}
</script>

<template>
  <section class="conversations" aria-labelledby="recent-conversations-title">
    <header>
      <h2 id="recent-conversations-title">Conversations</h2>
      <span>{{ conversations.length }}</span>
    </header>

    <NoxButton block variant="secondary" @click="session.newConversation()">
      + New conversation
    </NoxButton>

    <p v-if="session.catalog.type === 'loading'" class="conversations__state">Scanning links…</p>
    <p v-else-if="session.catalog.type === 'failed'" class="conversations__state">
      {{ session.catalog.message }}
    </p>
    <p v-else-if="conversations.length === 0" class="conversations__state">No previous signal.</p>

    <ol v-else>
      <li v-for="conversation in conversations" :key="conversation.conversationId">
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
  grid-template-rows: auto auto minmax(0, 1fr);
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

.conversations ol {
  display: grid;
  min-height: 0;
  margin: 0;
  gap: var(--nox-space-1);
  padding: 0;
  list-style: none;
  overflow-y: auto;
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
  text-align: left;
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
