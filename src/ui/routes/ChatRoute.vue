<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'

import { useAuthStore } from '@/app/stores/auth.store'
import { authErrorMessage } from '@/features/auth/model/errorMessage'
import ChatComposer from '@/features/chat/components/ChatComposer.vue'
import ChatTimeline from '@/features/chat/components/ChatTimeline.vue'
import { useActiveSessionStore } from '@/features/chat/stores/activeSession.store'
import { NoxButton } from '@/shared/ui/NoxButton'
import { NoxMark } from '@/shared/ui/NoxMark'
import { NoxNotice } from '@/shared/ui/NoxNotice'
import { NoxStatus } from '@/shared/ui/NoxStatus'

interface ConnectionStatus {
  readonly label: string
  readonly tone: 'danger' | 'operational' | 'waiting'
}

const auth = useAuthStore()
const session = useActiveSessionStore()
const account = computed(() => (auth.state.type === 'authenticated' ? auth.state.account : undefined))
const connectionStatus = computed<ConnectionStatus>(() => {
  switch (session.connection.type) {
    case 'connected':
      return { label: 'Stream connected', tone: 'operational' }
    case 'connecting':
      return { label: 'Connecting stream', tone: 'waiting' }
    case 'disconnected':
      return { label: 'Stream disconnected', tone: 'danger' }
    case 'failed':
      return { label: 'Stream failed', tone: 'danger' }
    case 'reconnecting':
      return { label: `Reconnecting // ${String(session.connection.attempt)}`, tone: 'waiting' }
    case 'unavailable':
      return { label: 'Chat unavailable', tone: 'danger' }
  }
  return { label: 'Unknown stream state', tone: 'danger' }
})
const shortConversationId = computed(() => session.conversationId.slice(-8).toUpperCase())
const logoutError = ref<string>()
const loggingOut = ref(false)

onMounted(() => {
  session.connect()
})

onBeforeUnmount(() => {
  session.disconnect()
})

async function logout(): Promise<void> {
  logoutError.value = undefined
  loggingOut.value = true
  try {
    await auth.logout()
  } catch (error) {
    logoutError.value = authErrorMessage(error)
  } finally {
    loggingOut.value = false
  }
}
</script>

<template>
  <main v-if="account !== undefined" class="chat">
    <aside class="sidebar">
      <NoxMark />

      <nav class="sidebar__nav" aria-label="Primary navigation">
        <RouterLink
          class="sidebar__item sidebar__item--active"
          :to="{ name: 'chat' }"
          aria-current="page"
        >
          <span>01</span> Chat
        </RouterLink>
        <span class="sidebar__item" aria-disabled="true"><span>02</span> Sessions</span>
        <span class="sidebar__item" aria-disabled="true"><span>03</span> Audit</span>
        <span class="sidebar__item" aria-disabled="true"><span>04</span> Settings</span>
      </nav>

      <footer class="sidebar__footer">
        <div>
          <span>IDENTITY</span>
          <strong>{{ account.username }}</strong>
        </div>
        <NoxButton :busy="loggingOut" variant="ghost" @click="logout()">Disconnect</NoxButton>
      </footer>
    </aside>

    <section class="surface" aria-labelledby="conversation-title">
      <header class="surface__header">
        <div>
          <p>WEB CONVERSATION // {{ shortConversationId }}</p>
          <h1 id="conversation-title">New conversation</h1>
        </div>
        <NoxStatus :label="connectionStatus.label" :tone="connectionStatus.tone" />
      </header>

      <div class="surface__body">
        <NoxNotice
          v-if="session.connection.type === 'unavailable'"
          class="surface__notice"
          title="Web broker unavailable"
          tone="danger"
        >
          <p>No configured web broker currently holds the chat surface.</p>
          <NoxButton variant="secondary" @click="session.reconnect()">Retry connection</NoxButton>
        </NoxNotice>

        <NoxNotice
          v-else-if="session.connection.type === 'failed'"
          class="surface__notice"
          title="Chat stream failed"
          tone="danger"
        >
          <p>{{ session.connection.message }}</p>
          <NoxButton variant="secondary" @click="session.reconnect()">Open a new stream</NoxButton>
        </NoxNotice>

        <ChatTimeline />

        <div class="surface__composer">
          <NoxNotice v-if="session.sendError !== undefined" title="Message not sent" tone="danger">
            <p>{{ session.sendError }}</p>
          </NoxNotice>
          <ChatComposer />
          <p class="surface__hint">Enter to execute · Shift + Enter for a new line</p>
        </div>
      </div>
    </section>

    <NoxNotice v-if="logoutError !== undefined" class="chat__logout-error" title="Logout failed">
      <p>{{ logoutError }}</p>
    </NoxNotice>
  </main>
</template>

<style scoped lang="scss">
.chat {
  display: grid;
  height: 100vh;
  grid-template-columns: 15rem minmax(0, 1fr);
  background: var(--nox-canvas);
  overflow: hidden;
}

.sidebar {
  display: flex;
  min-height: 0;
  flex-direction: column;
  padding: var(--nox-space-6);
  border-right: 1px solid var(--nox-border-subtle);
  background: var(--nox-canvas-raised);
}

.sidebar__nav {
  display: grid;
  gap: var(--nox-space-2);
  margin-top: var(--nox-space-16);
}

.sidebar__item {
  display: flex;
  align-items: center;
  gap: var(--nox-space-3);
  padding: var(--nox-space-3);
  border-left: 2px solid transparent;
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-sm);
  text-decoration: none;
}

.sidebar__item span {
  font-size: 0.62rem;
}

.sidebar__item--active {
  border-left-color: var(--nox-action-primary);
  color: var(--nox-text-primary);
  background: var(--nox-surface-1);
}

.sidebar__item[aria-disabled='true'] {
  cursor: not-allowed;
  opacity: 0.56;
}

.sidebar__footer {
  display: grid;
  gap: var(--nox-space-3);
  margin-top: auto;
  padding-top: var(--nox-space-4);
  border-top: 1px solid var(--nox-border-subtle);
}

.sidebar__footer > div {
  display: grid;
}

.sidebar__footer span,
.surface__header p,
.surface__hint {
  margin: 0;
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: 0.08em;
}

.sidebar__footer strong {
  color: var(--nox-text-secondary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-sm);
  font-weight: 500;
  overflow-wrap: anywhere;
}

.surface {
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-rows: auto 1fr;
}

.surface__header {
  display: flex;
  min-height: 5rem;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-6);
  padding: var(--nox-space-4) var(--nox-space-8);
  border-bottom: 1px solid var(--nox-border-subtle);
  background: var(--nox-canvas-raised);
}

.surface__header h1 {
  margin: var(--nox-space-1) 0 0;
  font-size: var(--nox-text-lg);
  line-height: var(--nox-leading-tight);
}

.surface__body {
  display: grid;
  min-height: 0;
  grid-template-rows: minmax(0, 1fr) auto;
  background: var(--nox-atmosphere), var(--nox-canvas);
}

.surface__notice {
  position: absolute;
  z-index: var(--nox-layer-overlay);
  top: 6rem;
  right: var(--nox-space-6);
  width: min(24rem, calc(100% - var(--nox-space-8)));
  box-shadow: var(--nox-shadow-panel);
}

.surface__notice :deep(.notice__body) {
  display: grid;
  gap: var(--nox-space-3);
}

.surface__composer {
  display: grid;
  width: min(100%, 56rem);
  justify-self: center;
  gap: var(--nox-space-2);
  padding: var(--nox-space-4) var(--nox-space-6) var(--nox-space-5);
}

.surface__hint {
  text-align: center;
}

.chat__logout-error {
  position: fixed;
  z-index: var(--nox-layer-toast);
  right: var(--nox-space-5);
  bottom: var(--nox-space-5);
  width: min(24rem, calc(100% - var(--nox-space-8)));
}

@media (max-width: 48rem) {
  .chat {
    grid-template-columns: 4.25rem minmax(0, 1fr);
  }

  .sidebar {
    align-items: center;
    padding: var(--nox-space-4) var(--nox-space-2);
  }

  .sidebar :deep(.mark__word),
  .sidebar__item:not(.sidebar__item--active),
  .sidebar__item--active,
  .sidebar__footer > div {
    font-size: 0;
  }

  .sidebar__item--active span {
    font-size: var(--nox-text-xs);
  }

  .surface__header {
    padding: var(--nox-space-4);
  }
}

@media (max-width: 36rem) {
  .chat {
    grid-template-columns: 1fr;
  }

  .sidebar {
    display: none;
  }

  .surface__header {
    min-height: 4rem;
  }

  .surface__header p,
  .surface__header :deep(.status > span:last-child) {
    display: none;
  }

  .surface__composer {
    padding: var(--nox-space-3);
  }
}
</style>
