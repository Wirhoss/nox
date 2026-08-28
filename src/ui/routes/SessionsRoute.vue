<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import AuditActionCard from '@/features/audit/components/AuditActionCard.vue'
import SessionTranscript from '@/features/sessions/components/SessionTranscript.vue'
import { useSessionsStore } from '@/features/sessions/stores/sessions.store'
import { useI18n } from '@/shared/i18n'
import { NoxButton } from '@/shared/ui/NoxButton'
import { NoxNotice } from '@/shared/ui/NoxNotice'
import { NoxPanel } from '@/shared/ui/NoxPanel'
import { NoxStatus } from '@/shared/ui/NoxStatus'

const sessions = useSessionsStore()
const route = useRoute()
const router = useRouter()
const { formatDate, formatNumber, t } = useI18n()
const selectedAgentIndex = ref('0')
const tab = ref<'audit' | 'conversation'>('conversation')
const openedSessionId = computed(() => routeParam('sessionId'))
const selectedAgent = computed(() => sessions.agents[Number(selectedAgentIndex.value)])
const hasPreviousAudit = computed(() => sessions.auditPage.offset > 0)
const hasNextAudit = computed(
  () =>
    sessions.auditPage.offset + sessions.auditPage.entries.length < sessions.auditPage.total,
)

onMounted(async () => {
  await sessions.loadAgents()
  const sessionId = openedSessionId.value
  if (sessionId !== undefined) {
    await sessions.openSession(sessionId)
    alignAgent()
    return
  }
  await loadSelectedAgent()
})

watch(openedSessionId, async (sessionId, previous) => {
  if (sessionId === previous) return
  if (sessionId === undefined) {
    await loadSelectedAgent()
    return
  }
  tab.value = 'conversation'
  await sessions.openSession(sessionId)
  alignAgent()
})

function routeParam(name: string): string | undefined {
  const value = route.params[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function alignAgent(): void {
  const agentId = sessions.activeSession?.agentId ?? null
  const index = sessions.agents.findIndex((agent) => agent.agentId === agentId)
  if (index >= 0) selectedAgentIndex.value = String(index)
}

async function loadSelectedAgent(): Promise<void> {
  const agent = selectedAgent.value
  if (agent === undefined) return
  await sessions.loadSessions(agent.agentId)
}

async function retryNavigation(): Promise<void> {
  await sessions.loadAgents()
  await loadSelectedAgent()
}

async function changeAgent(event: Event): Promise<void> {
  if (!(event.target instanceof HTMLSelectElement)) return
  selectedAgentIndex.value = event.target.value
  await loadSelectedAgent()
}

async function openSession(sessionId: string): Promise<void> {
  await router.push({ name: 'sessions', params: { sessionId } })
}

async function closeSession(): Promise<void> {
  await router.push({ name: 'sessions' })
}

async function changeAuditPage(direction: -1 | 1): Promise<void> {
  const sessionId = openedSessionId.value
  if (sessionId === undefined) return
  const offset = Math.max(0, sessions.auditPage.offset + direction * sessions.auditPage.limit)
  await sessions.loadAuditPage(sessionId, offset)
}

function moment(value: string): string {
  return formatDate(value, { dateStyle: 'medium', timeStyle: 'short' })
}
</script>

<template>
  <main class="sessions">
    <template v-if="openedSessionId === undefined">
      <header class="sessions__header">
        <div>
          <p>{{ t('sessions.eyebrow') }}</p>
          <h1>{{ t('sessions.title') }}</h1>
          <span>{{ t('sessions.subtitle') }}</span>
        </div>
        <NoxStatus
          :label="
            sessions.navigation.type === 'loading'
              ? t('sessions.state.loading')
              : t('sessions.state.count', { count: formatNumber(sessions.sessionPage.total) })
          "
          :tone="sessions.navigation.type === 'failed' ? 'danger' : sessions.navigation.type === 'loading' ? 'waiting' : 'operational'"
        />
      </header>

      <section class="sessions__browser" aria-labelledby="sessions-browser-title">
        <div class="sessions__agent">
          <label for="sessions-agent">{{ t('sessions.agent.label') }}</label>
          <select
            id="sessions-agent"
            :value="selectedAgentIndex"
            :disabled="sessions.navigation.type === 'loading' || sessions.agents.length === 0"
            @change="changeAgent"
          >
            <option v-for="(agent, index) in sessions.agents" :key="agent.agentId ?? 'legacy'" :value="String(index)">
              {{ agent.agentId ?? t('sessions.agent.unattributed') }} ·
              {{ t('sessions.agent.sessionCount', { count: formatNumber(agent.sessionCount) }) }}
            </option>
          </select>
        </div>

        <NoxNotice
          v-if="sessions.navigation.type === 'failed'"
          :title="t('sessions.error.title')"
          tone="danger"
        >
          <p>{{ sessions.navigation.message }}</p>
          <NoxButton variant="secondary" @click="retryNavigation()">
            {{ t('common.retryConnection') }}
          </NoxButton>
        </NoxNotice>

        <NoxPanel v-else class="sessions__panel" labelled-by="sessions-browser-title">
          <header class="sessions__panel-header">
            <div>
              <p>{{ t('sessions.agent.current') }}</p>
              <h2 id="sessions-browser-title">
                {{ selectedAgent?.agentId ?? t('sessions.agent.unattributed') }}
              </h2>
            </div>
          </header>

          <div v-if="sessions.navigation.type === 'loading'" class="sessions__empty">
            <NoxStatus :label="t('sessions.state.loading')" tone="waiting" />
          </div>
          <div v-else-if="sessions.agents.length === 0" class="sessions__empty">
            <strong>{{ t('sessions.empty.agentsTitle') }}</strong>
            <p>{{ t('sessions.empty.agentsBody') }}</p>
          </div>
          <div v-else-if="sessions.sessionPage.entries.length === 0" class="sessions__empty">
            <strong>{{ t('sessions.empty.sessionsTitle') }}</strong>
            <p>{{ t('sessions.empty.sessionsBody') }}</p>
          </div>
          <ol v-else class="sessions__list">
            <li v-for="session in sessions.sessionPage.entries" :key="session.sessionId">
              <button type="button" @click="openSession(session.sessionId)">
                <span class="sessions__session-mark" aria-hidden="true"></span>
                <span class="sessions__session-identity">
                  <strong>{{ session.title ?? t('sessions.untitled') }}</strong>
                  <code>{{ session.sessionId }}</code>
                </span>
                <span class="sessions__session-meta">
                  <time :datetime="session.updatedAt">{{ moment(session.updatedAt) }}</time>
                  <span>{{ t('sessions.open') }} →</span>
                </span>
              </button>
            </li>
          </ol>
        </NoxPanel>
      </section>
    </template>

    <template v-else>
      <header class="sessions__header sessions__header--detail">
        <NoxButton variant="ghost" @click="closeSession()">← {{ t('sessions.back') }}</NoxButton>
        <div class="sessions__title">
          <p>{{ sessions.activeSession?.agentId ?? t('sessions.agent.unattributed') }} // {{ openedSessionId }}</p>
          <h1>{{ sessions.activeSession?.title ?? t('sessions.untitled') }}</h1>
        </div>
        <NoxStatus
          :label="sessions.detail.type === 'loading' ? t('sessions.state.loadingSession') : t('sessions.state.archived')"
          :tone="sessions.detail.type === 'failed' ? 'danger' : sessions.detail.type === 'loading' ? 'waiting' : 'operational'"
        />
      </header>

      <NoxNotice
        v-if="sessions.detail.type === 'failed'"
        class="sessions__detail-error"
        :title="t('sessions.error.title')"
        tone="danger"
      >
        <p>{{ sessions.detail.message }}</p>
        <NoxButton variant="secondary" @click="sessions.openSession(openedSessionId)">
          {{ t('common.retryConnection') }}
        </NoxButton>
      </NoxNotice>

      <section v-else class="session-detail">
        <nav class="session-detail__tabs" :aria-label="t('sessions.tabs.label')">
          <button
            type="button"
            :class="{ 'session-detail__tab--active': tab === 'conversation' }"
            :aria-current="tab === 'conversation' ? 'page' : undefined"
            @click="tab = 'conversation'"
          >
            {{ t('sessions.tabs.conversation') }}
            <span>{{ formatNumber(sessions.transcript?.total ?? 0) }}</span>
          </button>
          <button
            type="button"
            :class="{ 'session-detail__tab--active': tab === 'audit' }"
            :aria-current="tab === 'audit' ? 'page' : undefined"
            @click="tab = 'audit'"
          >
            {{ t('sessions.tabs.audit') }}
            <span>{{ formatNumber(sessions.auditPage.total) }}</span>
          </button>
        </nav>

        <div class="session-detail__surface">
          <div v-if="sessions.detail.type === 'loading'" class="sessions__empty">
            <NoxStatus :label="t('sessions.state.loadingSession')" tone="waiting" />
          </div>
          <template v-else-if="tab === 'conversation'">
            <SessionTranscript
              v-if="(sessions.transcript?.entries.length ?? 0) > 0"
              :entries="sessions.transcript?.entries ?? []"
            />
            <div v-else class="sessions__empty">
              <strong>{{ t('sessions.empty.transcriptTitle') }}</strong>
              <p>{{ t('sessions.empty.transcriptBody') }}</p>
            </div>
          </template>
          <template v-else>
            <div v-if="sessions.auditPage.entries.length === 0" class="sessions__empty">
              <strong>{{ t('sessions.empty.auditTitle') }}</strong>
              <p>{{ t('sessions.empty.auditBody') }}</p>
            </div>
            <div v-else class="session-detail__audit">
              <AuditActionCard
                v-for="action in sessions.auditPage.entries"
                :key="action.trackId"
                :action="action"
              />
              <footer v-if="sessions.auditPage.total > sessions.auditPage.limit">
                <NoxButton :disabled="!hasPreviousAudit" variant="ghost" @click="changeAuditPage(-1)">
                  {{ t('audit.pagination.previous') }}
                </NoxButton>
                <span>{{ sessions.auditPage.offset + 1 }}–{{ sessions.auditPage.offset + sessions.auditPage.entries.length }} / {{ sessions.auditPage.total }}</span>
                <NoxButton :disabled="!hasNextAudit" variant="ghost" @click="changeAuditPage(1)">
                  {{ t('audit.pagination.next') }}
                </NoxButton>
              </footer>
            </div>
          </template>
        </div>
      </section>
    </template>
  </main>
</template>

<style scoped lang="scss">
.sessions {
  display: grid;
  height: 100%;
  min-height: 0;
  grid-template-rows: auto minmax(0, 1fr);
  background: var(--nox-atmosphere), var(--nox-canvas);
  overflow: hidden;
}

.sessions__header {
  display: flex;
  min-height: 6rem;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-6);
  padding: var(--nox-space-4) var(--nox-space-8);
  border-bottom: 1px solid var(--nox-border-subtle);
  background: var(--nox-canvas-raised);
}

.sessions__header p,
.sessions__header span {
  margin: 0;
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: 0.08em;
}

.sessions__header h1 {
  margin: var(--nox-space-1) 0;
  color: var(--nox-text-primary);
  font-size: var(--nox-text-lg);
}

.sessions__header--detail {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
}

.sessions__title {
  min-width: 0;
}

.sessions__title p,
.sessions__title h1 {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sessions__browser {
  width: min(100%, var(--nox-content-wide));
  min-height: 0;
  justify-self: center;
  padding: var(--nox-space-6);
  overflow: auto;
}

.sessions__agent {
  display: grid;
  max-width: 28rem;
  gap: var(--nox-space-2);
  margin-bottom: var(--nox-space-5);
}

.sessions__agent label,
.sessions__panel-header p {
  margin: 0;
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  font-weight: 700;
  letter-spacing: var(--nox-tracking-system);
  text-transform: uppercase;
}

.sessions__agent select {
  height: var(--nox-control-height);
  padding: 0 var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-primary);
  background: var(--nox-surface-input);
}

.sessions__agent select:focus {
  border-color: var(--nox-action-primary);
  outline: none;
  box-shadow: 0 0 0 1px var(--nox-action-primary);
}

.sessions__panel-header {
  padding: var(--nox-space-4) var(--nox-space-5);
  border-bottom: 1px solid var(--nox-border-subtle);
  background: var(--nox-canvas-raised);
}

.sessions__panel-header h2 {
  margin: var(--nox-space-1) 0 0;
  color: var(--nox-text-primary);
  font-size: var(--nox-text-md);
}

.sessions__list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.sessions__list li + li {
  border-top: 1px solid var(--nox-border-subtle);
}

.sessions__list button {
  display: grid;
  width: 100%;
  min-height: 5rem;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--nox-space-4);
  padding: var(--nox-space-4) var(--nox-space-5);
  border: 0;
  color: var(--nox-text-secondary);
  background: transparent;
  text-align: start;
  cursor: pointer;
}

.sessions__list button:hover {
  background: var(--nox-surface-hover);
}

.sessions__session-mark {
  width: 0.55rem;
  height: 0.55rem;
  border: 1px solid var(--nox-action-primary);
  border-radius: 50%;
  box-shadow: var(--nox-glow-operational);
}

.sessions__session-identity,
.sessions__session-meta {
  display: grid;
  min-width: 0;
  gap: var(--nox-space-1);
}

.sessions__session-identity strong {
  color: var(--nox-text-primary);
  font-size: var(--nox-text-sm);
}

.sessions__session-identity code,
.sessions__session-meta {
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.sessions__session-identity code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sessions__session-meta {
  justify-items: end;
}

.sessions__session-meta > span {
  color: var(--nox-action-primary);
}

.sessions__empty {
  display: grid;
  min-height: 18rem;
  align-content: center;
  justify-items: center;
  gap: var(--nox-space-2);
  padding: var(--nox-space-8);
  color: var(--nox-text-muted);
  text-align: center;
}

.sessions__empty strong {
  color: var(--nox-text-secondary);
  font-family: var(--nox-font-mono);
}

.sessions__empty p {
  max-width: 30rem;
  margin: 0;
  font-size: var(--nox-text-sm);
  line-height: var(--nox-leading-body);
}

.sessions__detail-error {
  align-self: start;
  margin: var(--nox-space-6);
}

.session-detail {
  display: grid;
  min-height: 0;
  grid-template-rows: auto minmax(0, 1fr);
}

.session-detail__tabs {
  display: flex;
  gap: var(--nox-space-2);
  padding: var(--nox-space-3) var(--nox-space-8) 0;
  border-bottom: 1px solid var(--nox-border-subtle);
  background: var(--nox-canvas-raised);
}

.session-detail__tabs button {
  display: flex;
  align-items: center;
  gap: var(--nox-space-2);
  padding: var(--nox-space-3) var(--nox-space-4);
  border: 0;
  border-bottom: 2px solid transparent;
  color: var(--nox-text-muted);
  background: transparent;
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-sm);
  cursor: pointer;
}

.session-detail__tabs button:hover,
.session-detail__tabs .session-detail__tab--active {
  border-bottom-color: var(--nox-action-primary);
  color: var(--nox-text-primary);
}

.session-detail__tabs span {
  padding: 0.1rem 0.35rem;
  border-radius: 999px;
  background: var(--nox-action-muted);
  font-size: var(--nox-text-xs);
}

.session-detail__surface {
  min-height: 0;
  overflow: auto;
}

.session-detail__audit {
  display: grid;
  width: min(100%, 68rem);
  gap: var(--nox-space-3);
  margin: 0 auto;
  padding: var(--nox-space-6);
}

.session-detail__audit footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

@media (max-width: 48rem) {
  .sessions__header,
  .sessions__header--detail {
    display: flex;
    align-items: flex-start;
    flex-direction: column;
    padding: var(--nox-space-4);
  }

  .sessions__browser,
  .session-detail__audit {
    padding: var(--nox-space-4);
  }

  .sessions__list button {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .sessions__session-meta {
    grid-column: 2;
    justify-items: start;
  }

  .session-detail__tabs {
    padding-inline: var(--nox-space-4);
  }
}
</style>
