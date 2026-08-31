<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import { useI18n } from '@/shared/i18n'

import { SETTINGS_GROUPS, settingsSections } from '../model/sections'
import { useSettingsStore } from '../stores/settings.store'

import type { SettingsSectionDefinition } from '../model/sections'

interface Props {
  reloadAvailable?: boolean
  reloadBusy?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  reloadAvailable: false,
  reloadBusy: false,
})
const emit = defineEmits<{ reload: [] }>()
const route = useRoute()
const { t } = useI18n()
const settings = useSettingsStore()
const activeSlug = computed(() => String(route.params.section ?? 'general'))
const definitions = computed(() => settingsSections(settings.catalog))
const activeDefinition = computed(() =>
  definitions.value.find((section) => section.slug === activeSlug.value),
)
const activeEntries = computed(() => {
  if (activeDefinition.value?.slug === 'secrets') {
    return settings.secrets.map((secret) => secret.secretId)
  }
  if (
    activeDefinition.value?.key === undefined ||
    settings.section?.key !== activeDefinition.value.key ||
    !settings.section.entries
  ) {
    return []
  }
  return Object.keys(settings.section.value)
})

function sectionsIn(
  group: SettingsSectionDefinition['group'],
): readonly SettingsSectionDefinition[] {
  return definitions.value.filter((section) => section.group === group)
}

function isLoaded(definition: SettingsSectionDefinition): boolean {
  if (definition.slug === 'secrets') return settings.resource.type === 'ready'
  return (
    settings.catalog?.sections.find((section) => section.key === definition.key)?.loaded ?? false
  )
}
</script>

<template>
  <aside class="settings-nav">
    <header class="settings-nav__header">
      <p>NOX // {{ t('settings.navigation.configuration') }}</p>
      <div class="settings-nav__title">
        <h1>{{ t('navigation.settings') }}</h1>
        <button
          v-if="props.reloadAvailable"
          class="settings-nav__reload"
          type="button"
          :aria-busy="props.reloadBusy"
          :aria-label="t('settings.runtime.reload')"
          :disabled="props.reloadBusy"
          :title="t('settings.runtime.reload')"
          @click="emit('reload')"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M20 7v5h-5M4 17v-5h5" />
            <path d="M6.1 9a7 7 0 0 1 11.6-2.6L20 9M4 15l2.3 2.6A7 7 0 0 0 17.9 15" />
          </svg>
        </button>
      </div>
      <span>{{ t('settings.navigation.controlSurface') }}</span>
    </header>

    <nav :aria-label="t('settings.navigation.sections')" class="settings-nav__groups">
      <section v-for="group in SETTINGS_GROUPS" :key="group" class="settings-nav__group">
        <h2>{{ t(`settings.group.${group}`) }}</h2>
        <div class="settings-nav__links">
          <template v-for="definition in sectionsIn(group)" :key="definition.slug">
            <RouterLink
              class="settings-nav__link"
              :class="{ 'settings-nav__link--active': activeSlug === definition.slug }"
              :to="{ name: 'settings', params: { section: definition.slug } }"
            >
              <span
                class="settings-nav__signal"
                :class="{ 'settings-nav__signal--online': isLoaded(definition) }"
                aria-hidden="true"
              ></span>
              <span>{{ t(definition.plural) }}</span>
              <small v-if="activeSlug === definition.slug && activeEntries.length > 0">
                {{ activeEntries.length }}
              </small>
            </RouterLink>

            <div
              v-if="
                activeSlug === definition.slug &&
                definition.key !== 'app' &&
                (definition.creatable || activeEntries.length > 0)
              "
              class="settings-nav__entries"
            >
              <RouterLink
                v-if="definition.creatable"
                class="settings-nav__new"
                :to="{
                  name: 'settings',
                  params: { section: definition.slug },
                  query: { create: '1' },
                }"
              >
                <span aria-hidden="true">+</span>
                {{ t('settings.navigation.newEntry', { entry: t(definition.label) }) }}
              </RouterLink>
              <RouterLink
                v-for="entryId in activeEntries"
                :key="entryId"
                class="settings-nav__entry"
                active-class="settings-nav__entry--active"
                :to="{
                  name: 'settings',
                  params: { entryId, section: definition.slug },
                }"
              >
                {{ entryId }}
              </RouterLink>
            </div>
          </template>
        </div>
      </section>
    </nav>
  </aside>
</template>

<style scoped lang="scss">
.settings-nav {
  min-width: 0;
  min-height: 0;
  padding: var(--nox-space-6) var(--nox-space-4);
  border-inline-end: 1px solid var(--nox-border-subtle);
  background: color-mix(in srgb, var(--nox-canvas-raised) 96%, transparent);
  overflow-y: auto;
}

.settings-nav__header {
  padding: 0 var(--nox-space-2) var(--nox-space-6);
  border-bottom: 1px solid var(--nox-border-subtle);
}

.settings-nav__header p,
.settings-nav__header span,
.settings-nav__group h2 {
  margin: 0;
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: var(--nox-tracking-system);
}

.settings-nav__title {
  display: flex;
  min-height: var(--nox-control-height);
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-3);
}

.settings-nav__header h1 {
  margin: var(--nox-space-2) 0 var(--nox-space-1);
  font-size: var(--nox-text-lg);
}

.settings-nav__header span {
  letter-spacing: 0;
}

.settings-nav__reload {
  display: grid;
  width: 2.25rem;
  height: 2.25rem;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-muted);
  background: var(--nox-surface-1);
  cursor: pointer;
  transition:
    color var(--nox-motion-fast) var(--nox-ease-out),
    background var(--nox-motion-fast) var(--nox-ease-out),
    border-color var(--nox-motion-fast) var(--nox-ease-out);
}

.settings-nav__reload:hover:not(:disabled) {
  border-color: var(--nox-action-primary);
  color: var(--nox-action-primary);
  background: var(--nox-surface-hover);
}

.settings-nav__reload:disabled {
  cursor: wait;
  opacity: 0.55;
}

.settings-nav__reload svg {
  width: 1rem;
  height: 1rem;
  fill: none;
  stroke: currentcolor;
  stroke-linecap: square;
  stroke-linejoin: miter;
  stroke-width: 1.7;
}

.settings-nav__reload[aria-busy='true'] svg {
  animation: settings-nav-reload 700ms linear infinite;
}

.settings-nav__groups {
  display: grid;
  gap: var(--nox-space-6);
  padding-top: var(--nox-space-6);
}

.settings-nav__group h2 {
  padding: 0 var(--nox-space-2) var(--nox-space-2);
  font-size: 0.62rem;
}

.settings-nav__links {
  display: grid;
  gap: var(--nox-space-1);
}

.settings-nav__link {
  display: grid;
  min-height: 2.5rem;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: var(--nox-space-3);
  padding: 0 var(--nox-space-3);
  border-inline-start: 2px solid transparent;
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-sm);
  text-decoration: none;
}

.settings-nav__link:hover,
.settings-nav__link--active {
  color: var(--nox-text-primary);
  background: var(--nox-surface-1);
}

.settings-nav__link--active {
  border-inline-start-color: var(--nox-action-primary);
}

.settings-nav__link small {
  color: var(--nox-text-muted);
  font-size: 0.62rem;
}

.settings-nav__signal {
  width: 0.35rem;
  height: 0.35rem;
  border-radius: 50%;
  background: var(--nox-border-strong);
}

.settings-nav__signal--online {
  background: var(--nox-status-success);
  box-shadow: var(--nox-glow-operational);
}

.settings-nav__entries {
  display: grid;
  gap: var(--nox-space-1);
  padding-block: var(--nox-space-1) var(--nox-space-2);
  padding-inline: var(--nox-space-6) 0;
}

.settings-nav__new,
.settings-nav__entry {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-2);
  padding: var(--nox-space-2) var(--nox-space-3);
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  text-decoration: none;
  overflow-wrap: anywhere;
}

.settings-nav__new {
  justify-content: flex-start;
  color: var(--nox-text-secondary);
}

.settings-nav__new span {
  color: var(--nox-action-primary);
}

.settings-nav__new:hover,
.settings-nav__entry:hover,
.settings-nav__entry--active {
  color: var(--nox-text-primary);
  background: var(--nox-surface-hover);
}

.settings-nav__entry--active {
  box-shadow: inset 1px 0 var(--nox-action-primary);
}

.settings-nav__entry small {
  color: var(--nox-action-primary);
  font-size: 0.56rem;
}

@keyframes settings-nav-reload {
  to {
    transform: rotate(1turn);
  }
}

@media (prefers-reduced-motion: reduce) {
  .settings-nav__reload,
  .settings-nav__reload[aria-busy='true'] svg {
    transition: none;
    animation: none;
  }
}

@media (max-width: 60rem) {
  .settings-nav {
    padding: var(--nox-space-4) var(--nox-space-3);
  }
}

@media (max-width: 48rem) {
  .settings-nav {
    border-inline-end: 0;
    border-bottom: 1px solid var(--nox-border-subtle);
  }

  .settings-nav__header {
    padding-bottom: var(--nox-space-4);
  }

  .settings-nav__groups {
    display: flex;
    gap: var(--nox-space-2);
    padding-top: var(--nox-space-4);
    overflow-x: auto;
  }

  .settings-nav__group {
    display: contents;
  }

  .settings-nav__group h2,
  .settings-nav__entries {
    display: none;
  }

  .settings-nav__links {
    display: flex;
  }

  .settings-nav__link {
    white-space: nowrap;
  }
}
</style>
