<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import AgentEditor from '@/features/settings/components/AgentEditor.vue'
import AppEditor from '@/features/settings/components/AppEditor.vue'
import BrokerEditor from '@/features/settings/components/BrokerEditor.vue'
import ConfigEntryList from '@/features/settings/components/ConfigEntryList.vue'
import ConfigJsonEditor from '@/features/settings/components/ConfigJsonEditor.vue'
import ProviderEditor from '@/features/settings/components/ProviderEditor.vue'
import SecretsManager from '@/features/settings/components/SecretsManager.vue'
import SettingsNavigation from '@/features/settings/components/SettingsNavigation.vue'
import ToolSetEditor from '@/features/settings/components/ToolSetEditor.vue'
import {
  SETTINGS_SECTIONS,
  settingsSection,
} from '@/features/settings/model/sections'
import { useSettingsStore } from '@/features/settings/stores/settings.store'
import { NoxButton } from '@/shared/ui/NoxButton'
import { NoxNotice } from '@/shared/ui/NoxNotice'

const route = useRoute()
const router = useRouter()
const settings = useSettingsStore()
const slug = computed(() => routeParam('section') ?? 'general')
const entryId = computed(() => routeParam('entryId'))
const definition = computed(() => settingsSection(slug.value) ?? SETTINGS_SECTIONS[0])
const creating = computed(
  () => definition.value.creatable && entryId.value === undefined && route.query.create === '1',
)
const section = computed(() => {
  const key = definition.value.key
  return key !== undefined && settings.section?.key === key ? settings.section : undefined
})
const targetExists = computed(() => {
  if (entryId.value === undefined) return true
  if (definition.value.slug === 'secrets') {
    return settings.secrets.some((secret) => secret.secretId === entryId.value)
  }
  return section.value !== undefined && entryId.value in section.value.value
})

watch(
  slug,
  async (nextSlug) => {
    const nextDefinition = settingsSection(nextSlug)
    if (nextDefinition === undefined) {
      await router.replace({ name: 'settings', params: { section: 'general' } })
      return
    }
    if (nextDefinition.slug === 'secrets') {
      await settings.loadSecrets()
      return
    }
    if (nextDefinition.key !== undefined) await settings.loadSection(nextDefinition.key)
  },
  { immediate: true },
)

async function retry(): Promise<void> {
  if (definition.value.slug === 'secrets') {
    await settings.loadSecrets()
  } else if (definition.value.key !== undefined) {
    await settings.loadSection(definition.value.key)
  }
}

async function openCreated(createdId: string): Promise<void> {
  await router.replace({
    name: 'settings',
    params: { entryId: createdId, section: slug.value },
  })
}

async function openSection(): Promise<void> {
  await router.replace({ name: 'settings', params: { section: slug.value } })
}

function routeParam(name: string): string | undefined {
  const value = route.params[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
</script>

<template>
  <main class="settings">
    <SettingsNavigation />

    <section class="settings__workbench" aria-live="polite">
      <div v-if="settings.resource.type === 'loading'" class="settings__loading">
        <span aria-hidden="true"></span>
        <div>
          <p>CONFIG LINK // READING</p>
          <h2>Loading {{ definition?.plural.toLowerCase() }}</h2>
        </div>
      </div>

      <div v-else-if="settings.resource.type === 'failed'" class="settings__failure">
        <NoxNotice title="Settings surface unavailable" tone="danger">
          <div class="settings__failure-body">
            <p>{{ settings.resource.message }}</p>
            <NoxButton variant="secondary" @click="retry()">Retry configuration link</NoxButton>
          </div>
        </NoxNotice>
      </div>

      <div v-else-if="!targetExists" class="settings__failure">
        <NoxNotice title="Configuration entry not found" tone="danger">
          <div class="settings__failure-body">
            <p>
              <code>{{ entryId }}</code> is not present in this section.
            </p>
            <NoxButton variant="secondary" @click="openSection()">
              Return to {{ definition?.plural }}
            </NoxButton>
          </div>
        </NoxNotice>
      </div>

      <SecretsManager
        v-else-if="definition?.slug === 'secrets'"
        :creating="creating"
        :definition="definition"
        :secret-id="entryId"
        @created="openCreated"
        @deleted="openSection"
      />

      <AppEditor
        v-else-if="section?.key === 'app'"
        :blueprint-section="settings.references.blueprints"
        :definition="definition"
        :section="section"
      />

      <AgentEditor
        v-else-if="
          section?.key === 'blueprints' && (creating || entryId !== undefined)
        "
        :creating="creating"
        :definition="definition"
        :entry-id="entryId"
        :provider-section="settings.references.providers"
        :section="section"
        :tool-set-section="settings.references.toolSets"
        @created="openCreated"
        @deleted="openSection"
      />

      <ProviderEditor
        v-else-if="section?.key === 'providers' && (creating || entryId !== undefined)"
        :creating="creating"
        :definition="definition"
        :entry-id="entryId"
        :section="section"
        @created="openCreated"
        @deleted="openSection"
      />

      <BrokerEditor
        v-else-if="section?.key === 'brokers' && (creating || entryId !== undefined)"
        :blueprint-section="settings.references.blueprints"
        :creating="creating"
        :definition="definition"
        :entry-id="entryId"
        :section="section"
        @created="openCreated"
        @deleted="openSection"
      />

      <ToolSetEditor
        v-else-if="section?.key === 'toolSets' && (creating || entryId !== undefined)"
        :creating="creating"
        :definition="definition"
        :entry-id="entryId"
        :section="section"
        @created="openCreated"
        @deleted="openSection"
      />

      <ConfigJsonEditor
        v-else-if="section !== undefined && (!section.entries || creating || entryId !== undefined)"
        :creating="creating"
        :definition="definition"
        :entry-id="entryId"
        :section="section"
        @created="openCreated"
        @deleted="openSection"
      />

      <ConfigEntryList
        v-else-if="section !== undefined"
        :definition="definition"
        :section="section"
      />
    </section>
  </main>
</template>

<style scoped lang="scss">
.settings {
  display: grid;
  height: 100%;
  grid-template-columns: 17rem minmax(0, 1fr);
  background: var(--nox-atmosphere), var(--nox-canvas);
  overflow: hidden;
}

.settings__workbench {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
}

.settings__loading,
.settings__failure {
  display: grid;
  min-height: 100%;
  place-items: center;
  padding: var(--nox-space-8);
}

.settings__loading {
  grid-template-columns: auto auto;
  align-content: center;
  gap: var(--nox-space-4);
  color: var(--nox-text-muted);
}

.settings__loading > span {
  width: 0.8rem;
  height: 0.8rem;
  border: 1px solid var(--nox-action-primary);
  box-shadow: var(--nox-glow-operational);
  animation: settings-pulse 1.2s steps(2, jump-none) infinite;
  transform: rotate(45deg);
}

.settings__loading p,
.settings__loading h2 {
  margin: 0;
}

.settings__loading p {
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: var(--nox-tracking-system);
}

.settings__loading h2 {
  color: var(--nox-text-secondary);
  font-size: var(--nox-text-md);
}

.settings__failure > :deep(*) {
  width: min(100%, 34rem);
}

.settings__failure-body {
  display: grid;
  gap: var(--nox-space-4);
}

.settings__failure-body code {
  color: var(--nox-text-primary);
}

@keyframes settings-pulse {
  50% {
    opacity: 0.25;
  }
}

@media (prefers-reduced-motion: reduce) {
  .settings__loading > span {
    animation: none;
  }
}

@media (max-width: 60rem) {
  .settings {
    grid-template-columns: 14rem minmax(0, 1fr);
  }
}

@media (max-width: 48rem) {
  .settings {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr);
  }
}
</style>
