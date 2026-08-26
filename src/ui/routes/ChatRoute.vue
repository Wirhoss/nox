<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'

import ChatComposer from '@/features/chat/components/ChatComposer.vue'
import ChatTimeline from '@/features/chat/components/ChatTimeline.vue'
import ConversationList from '@/features/chat/components/ConversationList.vue'
import { useActiveSessionStore } from '@/features/chat/stores/activeSession.store'
import { useI18n } from '@/shared/i18n'
import { NoxButton } from '@/shared/ui/NoxButton'
import { NoxNotice } from '@/shared/ui/NoxNotice'
import { NoxStatus } from '@/shared/ui/NoxStatus'

interface ConnectionStatus {
  readonly label: string
  readonly tone: 'danger' | 'operational' | 'waiting'
}

const session = useActiveSessionStore()
const { t } = useI18n()
const connectionStatus = computed<ConnectionStatus>(() => {
  switch (session.connection.type) {
    case 'connected':
      return { label: t('chat.connection.connected'), tone: 'operational' }
    case 'connecting':
      return { label: t('chat.connection.connecting'), tone: 'waiting' }
    case 'disconnected':
      return { label: t('chat.connection.disconnected'), tone: 'danger' }
    case 'failed':
      return { label: t('chat.connection.failed'), tone: 'danger' }
    case 'reconnecting':
      return {
        label: t('chat.connection.reconnecting', { attempt: session.connection.attempt }),
        tone: 'waiting',
      }
    case 'unavailable':
      return { label: t('chat.connection.unavailable'), tone: 'danger' }
  }
  return { label: t('chat.connection.unknown'), tone: 'danger' }
})
// The session's own name once it has one; a conversation that has not been
// named yet is still described by who is holding it.
const conversationTitle = computed(() => {
  const conversation = session.activeConversation
  if (conversation === undefined) return t('chat.conversation.new')
  return conversation.title ?? t('chat.conversation.withAgent', { agent: conversation.agentId })
})
const shortConversationId = computed(() => session.conversationId.slice(-8).toUpperCase())
const needsAgentSelection = computed(
  () => session.activeConversation === undefined && session.selectedAgentId === undefined,
)

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
          <p>{{ t('chat.conversation.web') }} // {{ shortConversationId }}</p>
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
          :title="t('chat.notice.unavailableTitle')"
          tone="danger"
        >
          <p>{{ t('chat.notice.unavailableBody') }}</p>
          <NoxButton variant="secondary" @click="session.reconnect()">{{
            t('common.retryConnection')
          }}</NoxButton>
        </NoxNotice>

        <NoxNotice
          v-else-if="session.connection.type === 'failed'"
          class="surface__notice"
          :title="t('chat.notice.streamFailed')"
          tone="danger"
        >
          <p>{{ session.connection.message }}</p>
          <NoxButton variant="secondary" @click="session.reconnect()">{{
            t('chat.notice.openNewStream')
          }}</NoxButton>
        </NoxNotice>

        <NoxNotice
          v-if="needsAgentSelection"
          class="surface__agent-selection"
          :title="t('chat.agent.chooseTitle')"
          :tone="session.agentIds.length === 0 ? 'danger' : 'info'"
        >
          <p v-if="session.agentIds.length === 0">{{ t('chat.agent.noneAvailable') }}</p>
          <label v-else for="new-conversation-agent">
            <span>{{ t('chat.agent.chooseHelp') }}</span>
            <select
              id="new-conversation-agent"
              :value="session.selectedAgentId ?? ''"
              @change="session.selectAgent(($event.target as HTMLSelectElement).value)"
            >
              <option value="" disabled>{{ t('chat.agent.choosePlaceholder') }}</option>
              <option v-for="agentId in session.agentIds" :key="agentId" :value="agentId">
                {{ agentId }}
              </option>
            </select>
          </label>
        </NoxNotice>

        <ChatTimeline />

        <div class="surface__composer">
          <NoxNotice
            v-if="session.sendError !== undefined"
            :title="t('chat.notice.messageNotSent')"
            tone="danger"
          >
            <p>{{ session.sendError }}</p>
          </NoxNotice>
          <ChatComposer />
          <p class="surface__hint">{{ t('chat.composer.keyboardHint') }}</p>
        </div>
      </div>
    </section>

    <aside class="conversation-rail" :aria-label="t('chat.conversation.browser')">
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

.surface__notice,
.surface__agent-selection {
  position: absolute;
  z-index: var(--nox-layer-overlay);
  top: 6rem;
  inset-inline-end: var(--nox-space-6);
  width: min(24rem, calc(100% - var(--nox-space-8)));
  box-shadow: var(--nox-shadow-panel);
}

.surface__notice :deep(.notice__body),
.surface__agent-selection :deep(.notice__body) {
  display: grid;
  gap: var(--nox-space-3);
}

.surface__agent-selection label {
  display: grid;
  gap: var(--nox-space-2);
  color: var(--nox-text-secondary);
  font-size: var(--nox-text-sm);
}

.surface__agent-selection select {
  min-height: var(--nox-control-height);
  padding: 0 var(--nox-space-3);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-primary);
  background: var(--nox-surface-input);
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
  border-inline-start: 1px solid var(--nox-border-subtle);
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
