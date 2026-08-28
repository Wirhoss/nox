<script setup lang="ts">
import { type Component, computed, watch } from 'vue'
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
import { settingsSection } from '@/features/settings/model/sections'
import { useSettingsStore } from '@/features/settings/stores/settings.store'
import { useI18n } from '@/shared/i18n'
import { NoxButton } from '@/shared/ui/NoxButton'
import { NoxNotice } from '@/shared/ui/NoxNotice'

const route = useRoute()
const { t } = useI18n()
const router = useRouter()
const settings = useSettingsStore()
const slug = computed(() => routeParam('section') ?? 'general')
const entryId = computed(() => routeParam('entryId'))
const definition = computed(() => settingsSection(settings.catalog, slug.value))
/** The contribution the list offered, when the form was reached by pressing one. */
const offeredType = computed(() =>
  typeof route.query.type === 'string' ? route.query.type : undefined,
)
/**
 * A section that is not freely creatable can still be configured from a
 * contribution it is offering. The two are different permissions: you cannot
 * invent a broker out of nothing, because there would be no type to give it —
 * but setting up one that is installed and named is exactly what the list is
 * inviting, and refusing it there would make the invitation do nothing.
 */
const creating = computed(
  () =>
    entryId.value === undefined &&
    route.query.create === '1' &&
    (definition.value?.creatable === true || offeredType.value !== undefined),
)
/**
 * A single-instance contribution owns its name, so the type is also the entry
 * ID, and the form should not ask a person to retype either.
 */
const presetType = computed(() => (creating.value ? offeredType.value : undefined))
const section = computed(() => {
  const key = definition.value?.key
  return key !== undefined && settings.section?.key === key ? settings.section : undefined
})
const runtimeIssues = computed(
  () =>
    settings.catalog?.runtime.filter(
      (component) => component.state === 'failed' || component.state === 'unavailable',
    ) ?? [],
)
const runtimeRestarts = computed(
  () =>
    settings.catalog?.runtime.filter((component) => component.state === 'restartRequired') ?? [],
)
const targetExists = computed(() => {
  if (entryId.value === undefined) return true
  if (definition.value?.slug === 'secrets') {
    return settings.secrets.some((secret) => secret.secretId === entryId.value)
  }
  return section.value !== undefined && entryId.value in section.value.value
})

const EDITOR_COMPONENTS: Readonly<Record<string, Component>> = Object.freeze({
  app: AppEditor,
  blueprint: AgentEditor,
  broker: BrokerEditor,
  contribution: ProviderEditor,
  json: ConfigJsonEditor,
  toolSet: ToolSetEditor,
})

const editorComponent = computed(() => {
  const editor = definition.value?.editor
  return editor === undefined || editor === 'secrets' ? undefined : EDITOR_COMPONENTS[editor]
})
const editingSection = computed(
  () => section.value !== undefined && (!section.value.entries || creating.value || entryId.value !== undefined),
)
const editorProps = computed<Record<string, unknown>>(() => {
  const currentDefinition = definition.value
  const currentSection = section.value
  if (currentDefinition === undefined || currentSection === undefined) return {}
  if (currentDefinition.editor === 'app') {
    return { definition: currentDefinition, section: currentSection }
  }

  const common = {
    creating: creating.value,
    definition: currentDefinition,
    entryId: entryId.value,
    section: currentSection,
  }
  if (currentDefinition.editor === 'blueprint') {
    return {
      ...common,
      memorySection: settings.references.memories,
      providerSection: settings.references.providers,
      toolSetSection: settings.references.toolSets,
    }
  }
  if (currentDefinition.editor === 'broker') {
    return {
      ...common,
      blueprintSection: settings.references.blueprints,
      presetType: presetType.value,
    }
  }
  if (currentDefinition.editor === 'contribution' || currentDefinition.editor === 'toolSet') {
    return { ...common, presetType: presetType.value }
  }
  return common
})

watch(
  slug,
  async (nextSlug) => {
    if (nextSlug === 'secrets') {
      await settings.loadSecrets()
      return
    }

    const catalog = await settings.loadCatalog()
    const nextDefinition = settingsSection(catalog, nextSlug)
    if (nextDefinition?.key === undefined) {
      await router.replace({ name: 'settings', params: { section: 'general' } })
      return
    }
    await settings.loadSection(nextDefinition.key)
  },
  { immediate: true },
)

async function reloadConfiguration(): Promise<void> {
  await settings.reloadConfiguration()
  if (definition.value?.key !== undefined) await settings.loadSection(definition.value.key)
}

async function retry(): Promise<void> {
  if (definition.value?.slug === 'secrets') {
    await settings.loadSecrets()
  } else if (definition.value?.key !== undefined) {
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
    <SettingsNavigation
      :reload-available="settings.catalog !== undefined"
      :reload-busy="settings.mutation.type === 'saving'"
      @reload="reloadConfiguration()"
    />

    <section class="settings__workbench" aria-live="polite">
      <NoxNotice
        v-if="runtimeRestarts.length > 0"
        class="settings__runtime"
        :title="t('settings.runtime.restartRequired')"
        tone="warning"
      >
        <p>{{ t('settings.runtime.restartRequiredHelp') }}</p>
        <ul>
          <li v-for="component in runtimeRestarts" :key="`${component.kind}:${component.id}`">
            <strong>{{ component.kind }} // {{ component.id }}</strong>
          </li>
        </ul>
      </NoxNotice>

      <NoxNotice
        v-if="runtimeIssues.length > 0"
        class="settings__runtime"
        :title="t('settings.runtime.degraded')"
        tone="danger"
      >
        <p>{{ t('settings.runtime.degradedHelp') }}</p>
        <ul>
          <li v-for="component in runtimeIssues" :key="`${component.kind}:${component.id}`">
            <strong>{{ component.kind }} // {{ component.id }}</strong>
            <span>{{ component.error ?? t('settings.runtime.unavailable') }}</span>
          </li>
        </ul>
        <div class="settings__runtime-actions">
          <NoxButton
            :busy="settings.mutation.type === 'saving'"
            variant="secondary"
            @click="settings.retryRuntime()"
          >
            {{ t('settings.runtime.retry') }}
          </NoxButton>
          <NoxButton
            v-if="settings.catalog?.revertAvailable"
            :busy="settings.mutation.type === 'saving'"
            variant="ghost"
            @click="settings.revertRuntime()"
          >
            {{ t('settings.runtime.revert') }}
          </NoxButton>
        </div>
      </NoxNotice>

      <div v-if="settings.resource.type === 'loading'" class="settings__loading">
        <span aria-hidden="true"></span>
        <div>
          <p>{{ t('settings.loading.link') }}</p>
          <h2>{{ t('settings.loading.section', { section: t(definition?.plural ?? '') }) }}</h2>
        </div>
      </div>

      <div v-else-if="settings.resource.type === 'failed'" class="settings__failure">
        <NoxNotice :title="t('settings.error.surfaceUnavailable')" tone="danger">
          <div class="settings__failure-body">
            <p>{{ settings.resource.message }}</p>
            <NoxButton variant="secondary" @click="retry()">{{
              t('settings.error.retryLink')
            }}</NoxButton>
          </div>
        </NoxNotice>
      </div>

      <div v-else-if="!targetExists" class="settings__failure">
        <NoxNotice :title="t('settings.error.entryNotFound')" tone="danger">
          <div class="settings__failure-body">
            <p>
              {{ t('settings.error.entryAbsent', { entry: entryId ?? '' }) }}
            </p>
            <NoxButton variant="secondary" @click="openSection()">
              {{ t('settings.error.returnTo', { section: t(definition?.plural ?? '') }) }}
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

      <component
        :is="editorComponent"
        v-else-if="editingSection && editorComponent !== undefined"
        v-bind="editorProps"
        @created="openCreated"
        @deleted="openSection"
      />

      <ConfigEntryList
        v-else-if="section !== undefined && definition !== undefined"
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

.settings__runtime {
  margin: var(--nox-space-5) var(--nox-space-8) 0;
}

.settings__runtime ul {
  display: grid;
  gap: var(--nox-space-2);
  padding: 0;
  list-style: none;
}

.settings__runtime li {
  display: grid;
  gap: var(--nox-space-1);
}

.settings__runtime-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--nox-space-2);
}

.settings__runtime strong {
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
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
