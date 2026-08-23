<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'

import ChatComposer from '@/features/chat/components/ChatComposer.vue'
import ChatTimeline from '@/features/chat/components/ChatTimeline.vue'
import ConversationList from '@/features/chat/components/ConversationList.vue'
import { useActiveSessionStore } from '@/features/chat/stores/activeSession.store'
import { NoxButton } from '@/shared/ui/NoxButton'
import { NoxNotice } from '@/shared/ui/NoxNotice'
import { NoxStatus } from '@/shared/ui/NoxStatus'

interface ConnectionStatus {
  readonly label: string
  readonly tone: 'danger' | 'operational' | 'waiting'
}

const session = useActiveSessionStore()
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
// The session's own name once it has one; a conversation that has not been
// named yet is still described by who is holding it.
const conversationTitle = computed(() => {
  const conversation = session.activeConversation
  if (conversation === undefined) return 'New conversation'
  return conversation.title ?? `Conversation with ${conversation.agentId}`
})
const shortConversationId = computed(() => session.conversationId.slice(-8).toUpperCase())

onMounted(() => {
  void session.initialize()
})

onBeforeUnmount(() => {
  session.disconnect()
})
</script>

<template>
  <main class="chat">
    <section class="surface" aria-labelledby="conversation-title">
      <header class="surface__header">
        <div>
          <p>WEB CONVERSATION // {{ shortConversationId }}</p>
          <h1 id="conversation-title">{{ conversationTitle }}</h1>
        </div>
        <div class="surface__telemetry">
          <NoxStatus :label="connectionStatus.label" :tone="connectionStatus.tone" />
        </div>
      </header>

      <div class="surface__body">
        <NoxNotice
          v-if="session.connection.type === 'unavailable'"
          class="surface__notice"
          title="Chat temporarily unavailable"
          tone="danger"
        >
          <p>The internal chat transport is not running.</p>
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

    <aside class="conversation-rail" aria-label="Conversation browser">
      <ConversationList />
    </aside>

  </main>
</template>

<style scoped lang="scss">
.chat {
  display: grid;
  height: 100%;
  grid-template-columns: minmax(0, 1fr) 18rem;
  background: var(--nox-canvas);
  overflow: hidden;
}

.surface__header p,
.surface__hint {
  margin: 0;
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: 0.08em;
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

.surface__telemetry {
  display: flex;
  align-items: center;
  gap: var(--nox-space-5);
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

.conversation-rail {
  min-width: 0;
  min-height: 0;
  padding: var(--nox-space-5) var(--nox-space-4);
  border-left: 1px solid var(--nox-border-subtle);
  background: var(--nox-canvas-raised);
  overflow: hidden;
}

@media (max-width: 75rem) {
  .chat {
    grid-template-columns: minmax(0, 1fr) 16rem;
  }
}

@media (max-width: 60rem) {
  .chat {
    grid-template-columns: minmax(0, 1fr);
  }

  .conversation-rail {
    display: none;
  }

  .surface__header {
    padding: var(--nox-space-4);
  }
}

@media (max-width: 36rem) {
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
