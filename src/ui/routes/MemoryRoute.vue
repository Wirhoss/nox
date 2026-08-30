<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { useMemoryStore } from '@/features/memory/stores/memory.store'
import { useI18n } from '@/shared/i18n'
import { NoxButton } from '@/shared/ui/NoxButton'
import { NoxNotice } from '@/shared/ui/NoxNotice'
import { NoxPanel } from '@/shared/ui/NoxPanel'
import { NoxStatus } from '@/shared/ui/NoxStatus'

import type { MemoryFact, MemoryScopeSummary } from '@/features/memory/api/memory.api'

/** The closed vocabulary the node accepts; kept in step with MEMORY_FACT_KINDS. */
const FACT_KINDS = ['decision', 'identity', 'preference', 'state'] as const

const memory = useMemoryStore()
const { formatDate, formatNumber, t } = useI18n()

/** The fact being corrected, if any. Editing one at a time is deliberate. */
const editingId = ref<string>()
const draftText = ref('')
const draftKind = ref('')
const mutationError = ref<string>()
const busy = ref(false)

const page = computed(() => (memory.tab === 'facts' ? memory.facts : memory.episodes))
const hasPrevious = computed(() => page.value.offset > 0)
const hasNext = computed(() => page.value.offset + page.value.entries.length < page.value.total)
const inspectable = computed(() => memory.memories.filter((entry) => entry.inspectable))

onMounted(async () => {
  await memory.loadMemories()
})

function moment(value: string | undefined): string {
  return value === undefined ? '—' : formatDate(value, { dateStyle: 'medium', timeStyle: 'short' })
}

function scopeLabel(scope: MemoryScopeSummary): string {
  return `${scope.agentId} · ${scope.principal.issuer}:${scope.principal.subject}`
}

function isLive(fact: MemoryFact): boolean {
  return fact.invalidatedAt === undefined
}

async function changeMemory(event: Event): Promise<void> {
  if (!(event.target instanceof HTMLSelectElement)) return
  await memory.selectMemory(event.target.value)
}

async function changeScope(event: Event): Promise<void> {
  if (!(event.target instanceof HTMLSelectElement)) return
  const scope = memory.scopes[Number(event.target.value)]
  if (scope !== undefined) await memory.selectScope(scope)
}

async function changePage(direction: -1 | 1): Promise<void> {
  const offset = Math.max(0, page.value.offset + direction * page.value.limit)
  await memory.loadPage(offset)
}

function startEditing(fact: MemoryFact): void {
  editingId.value = fact.id
  draftText.value = fact.text
  // A fact stored under a kind that is no longer offered — the tools once took
  // any string — has no option to select, so editing it means choosing a real
  // one. That is the only path by which those rows get corrected.
  draftKind.value = FACT_KINDS.includes(fact.kind as (typeof FACT_KINDS)[number])
    ? fact.kind
    : ''
  mutationError.value = undefined
}

function cancelEditing(): void {
  editingId.value = undefined
  mutationError.value = undefined
}

async function saveEdit(): Promise<void> {
  const id = editingId.value
  if (id === undefined || draftText.value.trim().length === 0) return
  if (draftKind.value.length === 0) {
    mutationError.value = t('memory.error.kindRequired')
    return
  }
  busy.value = true
  mutationError.value = undefined
  try {
    await memory.correct(id, draftKind.value.trim(), draftText.value.trim())
    editingId.value = undefined
  } catch {
    mutationError.value = t('memory.error.correctFailed')
  } finally {
    busy.value = false
  }
}

async function retire(fact: MemoryFact): Promise<void> {
  busy.value = true
  mutationError.value = undefined
  try {
    await memory.retire(fact.id)
  } catch {
    mutationError.value = t('memory.error.retireFailed')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main class="memory">
    <header class="memory__header">
      <div>
        <p>{{ t('memory.eyebrow') }}</p>
        <h1>{{ t('memory.title') }}</h1>
        <span>{{ t('memory.subtitle') }}</span>
      </div>
      <NoxStatus
        :label="
          memory.navigation.type === 'loading'
            ? t('memory.state.loading')
            : t('memory.state.count', { count: formatNumber(page.total) })
        "
        :tone="
          memory.navigation.type === 'failed'
            ? 'danger'
            : memory.navigation.type === 'loading'
              ? 'waiting'
              : 'operational'
        "
      />
    </header>

    <div class="memory__surface">
      <div class="memory__content">
        <NoxNotice
          v-if="memory.navigation.type === 'failed'"
          :title="t('memory.error.title')"
          tone="danger"
        >
          <p>{{ memory.navigation.message }}</p>
          <NoxButton variant="secondary" @click="memory.loadMemories()">
            {{ t('common.retryConnection') }}
          </NoxButton>
        </NoxNotice>

        <NoxNotice
          v-else-if="memory.navigation.type === 'ready' && inspectable.length === 0"
          :title="t('memory.empty.noMemoryTitle')"
        >
          <p>{{ t('memory.empty.noMemoryBody') }}</p>
        </NoxNotice>

        <template v-else-if="inspectable.length > 0">
          <section class="memory__controls">
            <div class="memory__field">
              <label for="memory-instance">{{ t('memory.instance') }}</label>
              <select
                id="memory-instance"
                :value="memory.activeMemoryId"
                :disabled="memory.navigation.type === 'loading'"
                @change="changeMemory"
              >
                <option v-for="entry in inspectable" :key="entry.id" :value="entry.id">
                  {{ entry.id }}
                </option>
              </select>
            </div>

            <div class="memory__field">
              <label for="memory-scope">{{ t('memory.scope') }}</label>
              <select
                id="memory-scope"
                :disabled="memory.navigation.type === 'loading' || memory.scopes.length === 0"
                @change="changeScope"
              >
                <option
                  v-for="(scope, index) in memory.scopes"
                  :key="scopeLabel(scope)"
                  :value="String(index)"
                >
                  {{ scopeLabel(scope) }} ·
                  {{ t('memory.scopeFacts', { count: formatNumber(scope.liveFactCount) }) }}
                </option>
              </select>
            </div>

            <nav class="memory__tabs" :aria-label="t('memory.tabs')">
              <button
                type="button"
                :class="{ 'memory__tab--active': memory.tab === 'facts' }"
                :aria-current="memory.tab === 'facts' ? 'true' : undefined"
                @click="memory.selectTab('facts')"
              >
                {{ t('memory.tab.facts') }}
              </button>
              <button
                type="button"
                :class="{ 'memory__tab--active': memory.tab === 'episodes' }"
                :aria-current="memory.tab === 'episodes' ? 'true' : undefined"
                @click="memory.selectTab('episodes')"
              >
                {{ t('memory.tab.episodes') }}
              </button>
            </nav>
          </section>

          <NoxNotice
            v-if="mutationError !== undefined"
            :title="t('memory.error.title')"
            tone="danger"
          >
            <p>{{ mutationError }}</p>
          </NoxNotice>

          <NoxNotice
            v-if="memory.detail.type === 'failed'"
            :title="t('memory.error.title')"
            tone="danger"
          >
            <p>{{ memory.detail.message }}</p>
          </NoxNotice>

          <NoxNotice
            v-else-if="memory.detail.type === 'ready' && page.entries.length === 0"
            :title="t('memory.empty.pageTitle')"
          >
            <p>{{ t('memory.empty.pageBody') }}</p>
          </NoxNotice>

          <div v-else class="memory__list">
            <template v-if="memory.tab === 'facts'">
              <NoxPanel v-for="fact in memory.facts.entries" :key="fact.id" class="memory__fact">
                <header class="memory__card-header">
                  <span class="memory__kind">{{ fact.kind }}</span>
                  <NoxStatus
                    :label="isLive(fact) ? t('memory.fact.live') : t('memory.fact.retired')"
                    :tone="isLive(fact) ? 'operational' : 'waiting'"
                  />
                </header>

                <div class="memory__card-body">
                  <template v-if="editingId === fact.id">
                    <div class="memory__field">
                      <label :for="`memory-kind-${fact.id}`">{{ t('memory.fact.kind') }}</label>
                      <select :id="`memory-kind-${fact.id}`" v-model="draftKind">
                        <option v-for="value in FACT_KINDS" :key="value" :value="value">
                          {{ t(`memory.kind.${value}`) }}
                        </option>
                      </select>
                    </div>
                    <div class="memory__field">
                      <label :for="`memory-text-${fact.id}`">{{ t('memory.fact.text') }}</label>
                      <textarea
                        :id="`memory-text-${fact.id}`"
                        v-model="draftText"
                        rows="3"
                      ></textarea>
                    </div>
                    <div class="memory__actions">
                      <NoxButton :busy="busy" @click="saveEdit()">
                        {{ t('memory.action.save') }}
                      </NoxButton>
                      <NoxButton variant="ghost" @click="cancelEditing()">
                        {{ t('memory.action.cancel') }}
                      </NoxButton>
                    </div>
                  </template>

                  <template v-else>
                    <p class="memory__text">{{ fact.text }}</p>
                    <dl class="memory__meta">
                      <div>
                        <dt>{{ t('memory.fact.validFrom') }}</dt>
                        <dd>{{ moment(fact.validFrom) }}</dd>
                      </div>
                      <div v-if="fact.validTo !== undefined">
                        <dt>{{ t('memory.fact.validTo') }}</dt>
                        <dd>{{ moment(fact.validTo) }}</dd>
                      </div>
                      <div>
                        <dt>{{ t('memory.fact.support') }}</dt>
                        <dd>{{ formatNumber(fact.supportCount) }}</dd>
                      </div>
                      <div>
                        <dt>{{ t('memory.fact.recalled') }}</dt>
                        <dd>{{ formatNumber(fact.accessCount) }}</dd>
                      </div>
                      <div v-if="fact.invalidatedBy !== undefined">
                        <dt>{{ t('memory.fact.supersededBy') }}</dt>
                        <dd>{{ fact.invalidatedBy }}</dd>
                      </div>
                    </dl>

                    <details v-if="fact.provenance.length > 0" class="memory__details">
                      <summary>
                        {{ t('memory.fact.provenance', { count: fact.provenance.length }) }}
                      </summary>
                      <ul class="memory__provenance">
                        <li v-for="entry in fact.provenance" :key="entry.episodeId">
                          {{ moment(entry.completedAt) }} · {{ entry.trigger }} ·
                          {{ entry.sessionId }}
                        </li>
                      </ul>
                    </details>

                    <div v-if="memory.editable && isLive(fact)" class="memory__actions">
                      <NoxButton variant="secondary" @click="startEditing(fact)">
                        {{ t('memory.action.correct') }}
                      </NoxButton>
                      <NoxButton :busy="busy" variant="ghost" @click="retire(fact)">
                        {{ t('memory.action.retire') }}
                      </NoxButton>
                    </div>
                  </template>
                </div>
              </NoxPanel>
            </template>

            <template v-else>
              <NoxPanel
                v-for="episode in memory.episodes.entries"
                :key="episode.episodeId"
                class="memory__episode"
              >
                <header class="memory__card-header">
                  <span class="memory__moment">{{ moment(episode.completedAt) }}</span>
                  <NoxStatus
                    :label="
                      episode.extractedAt === undefined
                        ? t('memory.episode.pending')
                        : t('memory.episode.extracted')
                    "
                    :tone="episode.extractedAt === undefined ? 'waiting' : 'operational'"
                  />
                </header>
                <div class="memory__card-body">
                  <p class="memory__episode-meta">
                    <span>{{ episode.trigger }}</span>
                    <span>{{ episode.status }}</span>
                    <span>{{ t('memory.episode.facts', { count: episode.factIds.length }) }}</span>
                  </p>
                  <details class="memory__details">
                    <summary>{{ t('memory.episode.transcript') }}</summary>
                    <pre>{{ episode.transcript }}</pre>
                  </details>
                </div>
              </NoxPanel>
            </template>
          </div>

          <nav class="memory__pager" :aria-label="t('memory.pager')">
            <NoxButton :disabled="!hasPrevious" variant="ghost" @click="changePage(-1)">
              {{ t('common.previous') }}
            </NoxButton>
            <span>
              {{
                t('memory.pageRange', {
                  from: formatNumber(page.offset + 1),
                  to: formatNumber(page.offset + page.entries.length),
                  total: formatNumber(page.total),
                })
              }}
            </span>
            <NoxButton :disabled="!hasNext" variant="ghost" @click="changePage(1)">
              {{ t('common.next') }}
            </NoxButton>
          </nav>
        </template>
      </div>
    </div>
  </main>
</template>

<style scoped lang="scss">
.memory {
  display: grid;
  height: 100%;
  min-height: 0;
  grid-template-rows: auto minmax(0, 1fr);
  background: var(--nox-atmosphere), var(--nox-canvas);
  overflow: hidden;
}

.memory__header {
  display: flex;
  min-height: 6rem;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-6);
  padding: var(--nox-space-4) var(--nox-space-8);
  border-bottom: 1px solid var(--nox-border-subtle);
  background: var(--nox-canvas-raised);
}

.memory__header p,
.memory__header span {
  margin: 0;
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: 0.08em;
}

.memory__header h1 {
  margin: var(--nox-space-1) 0;
  color: var(--nox-text-primary);
  font-size: var(--nox-text-lg);
}

/* The shell surface is overflow:hidden, so the route owns its own scroll. */
.memory__surface {
  min-height: 0;
  overflow-y: auto;
}

.memory__content {
  display: grid;
  width: min(100%, var(--nox-content-wide));
  align-content: start;
  gap: var(--nox-space-5);
  margin: 0 auto;
  padding: var(--nox-space-6) var(--nox-space-8) var(--nox-space-10);
}

.memory__controls {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: var(--nox-space-4);
}

.memory__field {
  display: grid;
  min-width: 0;
  flex: 1 1 18rem;
  gap: var(--nox-space-2);
}

.memory__field label {
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  font-weight: 700;
  letter-spacing: var(--nox-tracking-system);
  text-transform: uppercase;
}

.memory__field select,
.memory__field textarea {
  width: 100%;
  padding: 0 var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-primary);
  background: var(--nox-surface-input);
  font-family: inherit;
  font-size: var(--nox-text-sm);
}

.memory__field select {
  height: var(--nox-control-height);
  text-overflow: ellipsis;
}

.memory__field textarea {
  padding: var(--nox-space-3) var(--nox-space-4);
  line-height: var(--nox-leading-body);
  resize: vertical;
}

.memory__field select:focus,
.memory__field textarea:focus {
  border-color: var(--nox-action-primary);
  outline: none;
  box-shadow: 0 0 0 1px var(--nox-action-primary);
}

.memory__field select:disabled {
  cursor: not-allowed;
  opacity: 0.56;
}

.memory__tabs {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--nox-space-1);
  padding: var(--nox-space-1);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  background: var(--nox-surface-1);
}

.memory__tabs button {
  padding: var(--nox-space-2) var(--nox-space-4);
  border: 0;
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-muted);
  background: transparent;
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-sm);
  cursor: pointer;
}

.memory__tabs button:hover {
  color: var(--nox-text-primary);
  background: var(--nox-surface-hover);
}

.memory__tabs .memory__tab--active {
  color: var(--nox-text-primary);
  background: var(--nox-action-muted);
}

.memory__list {
  display: grid;
  gap: var(--nox-space-4);
}

.memory__card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-4);
  padding: var(--nox-space-3) var(--nox-space-5);
  border-bottom: 1px solid var(--nox-border-subtle);
  background: var(--nox-canvas-raised);
}

.memory__card-body {
  display: grid;
  gap: var(--nox-space-4);
  padding: var(--nox-space-5);
}

.memory__kind,
.memory__moment {
  color: var(--nox-action-primary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  font-weight: 700;
  letter-spacing: var(--nox-tracking-system);
  text-transform: uppercase;
}

.memory__moment {
  color: var(--nox-text-secondary);
  letter-spacing: 0.08em;
}

.memory__text {
  margin: 0;
  color: var(--nox-text-primary);
  font-size: var(--nox-text-md);
  line-height: var(--nox-leading-body);
  overflow-wrap: anywhere;
}

.memory__meta {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
  gap: var(--nox-space-3) var(--nox-space-5);
  margin: 0;
}

.memory__meta > div {
  display: grid;
  min-width: 0;
  gap: var(--nox-space-1);
}

.memory__meta dt {
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.memory__meta dd {
  margin: 0;
  color: var(--nox-text-secondary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  overflow-wrap: anywhere;
}

.memory__episode-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--nox-space-2) var(--nox-space-3);
  margin: 0;
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.memory__episode-meta span + span::before {
  margin-inline-end: var(--nox-space-3);
  content: '·';
}

.memory__details summary {
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: 0.06em;
  cursor: pointer;
}

.memory__details summary:hover {
  color: var(--nox-text-primary);
}

.memory__details[open] summary {
  margin-bottom: var(--nox-space-3);
  color: var(--nox-text-secondary);
}

.memory__provenance {
  display: grid;
  gap: var(--nox-space-2);
  margin: 0;
  padding: var(--nox-space-3) var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  background: var(--nox-surface-2);
  color: var(--nox-text-secondary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  list-style: none;
  overflow-wrap: anywhere;
}

.memory__episode pre {
  max-height: 24rem;
  margin: 0;
  padding: var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  background: var(--nox-surface-2);
  color: var(--nox-text-secondary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  line-height: var(--nox-leading-body);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-y: auto;
}

.memory__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--nox-space-2);
}

.memory__pager {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-4);
  padding-top: var(--nox-space-4);
  border-top: 1px solid var(--nox-border-subtle);
}

.memory__pager span {
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

@media (max-width: 48rem) {
  .memory__header {
    flex-wrap: wrap;
    align-items: flex-start;
    gap: var(--nox-space-3);
    padding: var(--nox-space-4) var(--nox-space-5);
  }

  .memory__content {
    padding: var(--nox-space-5) var(--nox-space-4) var(--nox-space-8);
  }

  .memory__tabs {
    flex: 1 1 100%;
  }

  .memory__tabs button {
    flex: 1;
  }
}
</style>
