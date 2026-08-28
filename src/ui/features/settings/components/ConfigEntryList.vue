<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'

import { useI18n } from '@/shared/i18n'

import type { ConfigSection, ConfigValue } from '../api/settings.api'
import type { SettingsSectionDefinition } from '../model/sections'

interface Props {
  definition: SettingsSectionDefinition
  section: ConfigSection
}

const props = defineProps<Props>()
const { t } = useI18n()
const entries = computed(() =>
  Object.entries(props.section.value).map(([entryId, value]) => ({
    entryId,
    value: isConfigValue(value) ? value : {},
  })),
)
/**
 * Installed contributions this section could hold and does not yet.
 *
 * Only the single-instance ones: those own their name, so there is exactly one
 * entry they could ever be and the list can offer it. A many-instance
 * contribution has no particular entry waiting to exist — how many and under
 * what names is the operator's decision, and the create form is where it is made.
 */
const available = computed(() =>
  (props.section.contributions ?? []).filter(
    (contribution) => contribution.instances === 'single' && !contribution.configured,
  ),
)

function detail(value: ConfigValue): string {
  const fields = props.section.entrySummary?.detail ?? []
  const summary = fields.flatMap((path) => scalarAt(value, path)).join(' // ')
  return summary.length > 0 ? summary : t('settings.entries.configuredEntry')
}

function description(value: ConfigValue): string | undefined {
  const fields = props.section.entrySummary?.description ?? []
  return fields.flatMap((path) => scalarAt(value, path))[0]
}

function scalarAt(value: ConfigValue, path: string): string[] {
  let current: unknown = value
  for (const segment of path.split('.')) {
    if (!isConfigValue(current)) return []
    current = current[segment]
  }
  return typeof current === 'string' && current.length > 0 ? [current] : []
}

function isConfigValue(value: unknown): value is ConfigValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
</script>

<template>
  <article class="entry-list">
    <header class="entry-list__header">
      <div>
        <p>{{ t('settings.navigation.configuration') }} // {{ props.section.key.toUpperCase() }}</p>
        <h2>{{ t(props.definition.plural) }}</h2>
        <span>{{ t(props.definition.description) }}</span>
      </div>
      <RouterLink
        v-if="props.definition.creatable"
        class="entry-list__create"
        :to="{
          name: 'settings',
          params: { section: props.definition.slug },
          query: { create: '1' },
        }"
      >
        + {{ t('settings.navigation.newEntry', { entry: t(props.definition.label) }) }}
      </RouterLink>
    </header>

    <div class="entry-list__content">
      <div class="entry-list__telemetry">
        <div>
          <span>{{ t('settings.entries.configured') }}</span>
          <strong>{{ entries.length }}</strong>
        </div>
        <div>
          <span>{{ t('settings.entries.source') }}</span>
          <strong>{{ props.section.name }}</strong>
        </div>
        <div>
          <span>{{ t('settings.entries.activation') }}</span>
          <strong>{{
            props.section.applies === 'restart'
              ? t('settings.entries.restart')
              : t('settings.entries.immediate')
          }}</strong>
        </div>
      </div>

      <section
        v-if="available.length > 0"
        class="entry-list__available"
        :aria-label="t('settings.entries.available')"
      >
        <p class="entry-list__available-note">{{ t('settings.entries.readyToConfigure') }}</p>
        <RouterLink
          v-for="contribution in available"
          :key="contribution.type"
          class="entry-list__entry entry-list__entry--available"
          :to="{
            name: 'settings',
            params: { section: props.definition.slug },
            query: { create: '1', type: contribution.type },
          }"
        >
          <span class="entry-list__marker" aria-hidden="true"></span>
          <div>
            <span class="entry-list__id">{{ contribution.type }}</span>
            <strong>{{ t('settings.entries.notConfigured') }}</strong>
            <p>{{ t('settings.entries.notConfiguredHelp') }}</p>
          </div>
          <span class="entry-list__open">{{ t('settings.entries.configure') }}</span>
        </RouterLink>
      </section>

      <section
        v-if="entries.length > 0"
        class="entry-list__entries"
        :aria-label="t(props.definition.plural)"
      >
        <RouterLink
          v-for="entry in entries"
          :key="entry.entryId"
          class="entry-list__entry"
          :to="{
            name: 'settings',
            params: { entryId: entry.entryId, section: props.definition.slug },
          }"
        >
          <span class="entry-list__marker" aria-hidden="true"></span>
          <div>
            <span class="entry-list__id">
              {{ entry.entryId }}
            </span>
            <strong>{{ detail(entry.value) }}</strong>
            <p v-if="description(entry.value) !== undefined">{{ description(entry.value) }}</p>
          </div>
          <span class="entry-list__open">{{ t('common.open') }} →</span>
        </RouterLink>
      </section>

      <section v-else-if="available.length === 0" class="entry-list__empty">
        <span aria-hidden="true">∅</span>
        <div>
          <h3>
            {{ t('settings.entries.noneConfigured', { section: t(props.definition.plural) }) }}
          </h3>
          <p v-if="props.definition.creatable">
            {{ t('settings.entries.emptyCreatable') }}
          </p>
          <p v-else>
            {{ t('settings.entries.emptyContributed') }}
          </p>
        </div>
      </section>
    </div>
  </article>
</template>

<style scoped lang="scss">
.entry-list {
  min-height: 100%;
}

.entry-list__header {
  display: flex;
  min-height: 7.5rem;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-8);
  padding: var(--nox-space-6) var(--nox-space-8);
  border-bottom: 1px solid var(--nox-border-subtle);
  background: var(--nox-canvas-raised);
}

.entry-list__header p,
.entry-list__header span,
.entry-list__telemetry span {
  margin: 0;
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: 0.07em;
}

.entry-list__header h2 {
  margin: var(--nox-space-1) 0 var(--nox-space-2);
  font-size: clamp(1.35rem, 3vw, 2rem);
  line-height: var(--nox-leading-tight);
}

.entry-list__create {
  display: inline-flex;
  min-height: var(--nox-control-height);
  align-items: center;
  padding: 0 var(--nox-space-5);
  border: 1px solid transparent;
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-inverse);
  background: var(--nox-action-primary);
  box-shadow: var(--nox-glow-operational);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-sm);
  font-weight: 700;
  text-decoration: none;
}

.entry-list__content {
  display: grid;
  width: min(100%, 64rem);
  align-content: start;
  gap: var(--nox-space-8);
  margin: 0 auto;
  padding: var(--nox-space-8);
}

.entry-list__telemetry {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  border: 1px solid var(--nox-border-subtle);
  background: var(--nox-surface-1);
}

.entry-list__telemetry > div {
  display: grid;
  gap: var(--nox-space-2);
  padding: var(--nox-space-4);
}

.entry-list__telemetry > div + div {
  border-inline-start: 1px solid var(--nox-border-subtle);
}

.entry-list__telemetry strong {
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-sm);
  font-weight: 500;
  overflow-wrap: anywhere;
}

.entry-list__entries {
  display: grid;
  border-top: 1px solid var(--nox-border-subtle);
}

.entry-list__entry {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--nox-space-4);
  padding: var(--nox-space-5) var(--nox-space-4);
  border-bottom: 1px solid var(--nox-border-subtle);
  color: var(--nox-text-primary);
  text-decoration: none;
}

.entry-list__entry:hover {
  background: var(--nox-surface-hover);
}

.entry-list__marker {
  width: 0.5rem;
  height: 0.5rem;
  border: 1px solid var(--nox-action-primary);
  box-shadow: var(--nox-glow-operational);
  transform: rotate(45deg);
}

.entry-list__entry > div {
  min-width: 0;
}

.entry-list__id {
  display: flex;
  align-items: center;
  gap: var(--nox-space-2);
  color: var(--nox-text-primary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-md);
  overflow-wrap: anywhere;
}

.entry-list__id small {
  padding: 0.1rem var(--nox-space-2);
  border: 1px solid color-mix(in srgb, var(--nox-action-primary) 45%, transparent);
  color: var(--nox-action-primary);
  font-size: 0.56rem;
}

.entry-list__entry strong,
.entry-list__entry p,
.entry-list__open {
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  font-weight: 400;
}

.entry-list__entry p {
  margin: var(--nox-space-1) 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.entry-list__open {
  color: var(--nox-text-secondary);
}

.entry-list__empty {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: start;
  gap: var(--nox-space-4);
  padding: var(--nox-space-8);
  border: 1px dashed var(--nox-border-strong);
  color: var(--nox-text-muted);
}

.entry-list__empty > span {
  color: var(--nox-action-primary);
  font-family: var(--nox-font-mono);
  font-size: 1.5rem;
}

.entry-list__empty h3,
.entry-list__empty p {
  margin: 0;
}

.entry-list__empty h3 {
  color: var(--nox-text-primary);
  font-size: var(--nox-text-md);
}

.entry-list__empty p {
  margin-top: var(--nox-space-2);
  font-size: var(--nox-text-sm);
}

@media (max-width: 60rem) {
  .entry-list__header,
  .entry-list__content {
    padding-inline: var(--nox-space-5);
  }
}

@media (max-width: 36rem) {
  .entry-list__header {
    align-items: flex-start;
    flex-direction: column;
  }

  .entry-list__telemetry {
    grid-template-columns: 1fr;
  }

  .entry-list__telemetry > div + div {
    border-top: 1px solid var(--nox-border-subtle);
    border-inline-start: 0;
  }

  .entry-list__open {
    display: none;
  }
}
</style>
