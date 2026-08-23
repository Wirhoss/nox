<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'

import { useI18n } from '@/shared/i18n'
import { NoxButton } from '@/shared/ui/NoxButton'
import { NoxNotice } from '@/shared/ui/NoxNotice'
import { NoxTextField } from '@/shared/ui/NoxTextField'

import { useSettingsStore } from '../stores/settings.store'

import type { ConfigSection, ConfigValue } from '../api/settings.api'
import type { SettingsSectionDefinition } from '../model/sections'

interface Props {
  creating?: boolean
  definition: SettingsSectionDefinition
  entryId?: string
  section: ConfigSection
}

const props = withDefaults(defineProps<Props>(), {
  creating: false,
  entryId: undefined,
})
const emit = defineEmits<{ created: [entryId: string]; deleted: [] }>()
const settings = useSettingsStore()
const { t } = useI18n()
const source = ref('')
const original = ref('')
const entryIdInput = ref('')
const sourceError = ref<string>()
const entryIdError = ref<string>()
const confirmingDelete = ref(false)
const selectedValue = computed<ConfigValue | undefined>(() => {
  if (props.creating) return newEntryTemplate(props.section.key)
  if (props.entryId === undefined) return props.section.value
  const value = props.section.value[props.entryId]
  return isConfigValue(value) ? value : undefined
})
const dirty = computed(() => source.value !== original.value)
const title = computed(() => {
  if (props.creating) return t('settings.navigation.newEntry', { entry: t(props.definition.label) })
  return props.entryId ?? t(props.definition.plural)
})
const sourceName = computed(() => {
  if (props.entryId !== undefined && props.section.kind === 'directory') {
    return `${props.section.name}/${props.entryId}.json`
  }
  return props.section.name
})

watch(
  [() => props.creating, () => props.entryId, selectedValue],
  () => {
    resetEditor()
  },
  { immediate: true },
)

function resetEditor(): void {
  const next = JSON.stringify(selectedValue.value ?? {}, undefined, 2)
  source.value = next
  original.value = next
  entryIdInput.value = ''
  sourceError.value = undefined
  entryIdError.value = undefined
  confirmingDelete.value = false
}

function formatSource(): void {
  const parsed = parseSource()
  if (parsed === undefined) return
  source.value = JSON.stringify(parsed, undefined, 2)
}

async function save(): Promise<void> {
  sourceError.value = undefined
  entryIdError.value = undefined
  const value = parseSource()
  if (value === undefined) return

  let saved: boolean
  if (props.creating) {
    const entryId = entryIdInput.value.trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(entryId)) {
      entryIdError.value = t('settings.validation.entryId')
      return
    }
    saved = await settings.createEntry(props.section.key, entryId, value)
    if (saved) emit('created', entryId)
  } else if (props.entryId !== undefined) {
    saved = await settings.saveEntry(props.section.key, props.entryId, value)
  } else {
    saved = await settings.saveSection(props.section.key, value)
  }

  if (saved) original.value = JSON.stringify(value, undefined, 2)
}

async function remove(): Promise<void> {
  if (props.entryId === undefined) return
  if (await settings.deleteEntry(props.section.key, props.entryId)) emit('deleted')
}

function parseSource(): ConfigValue | undefined {
  try {
    const parsed: unknown = JSON.parse(source.value)
    if (!isConfigValue(parsed)) {
      sourceError.value = t('settings.validation.configurationObject')
      return undefined
    }
    return parsed
  } catch {
    sourceError.value = t('settings.validation.invalidJson')
    return undefined
  }
}

function canLeave(): boolean {
  return !dirty.value || window.confirm(t('settings.confirm.discardConfiguration'))
}

onBeforeRouteLeave(canLeave)
onBeforeRouteUpdate(canLeave)

function isConfigValue(value: unknown): value is ConfigValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function newEntryTemplate(_sectionKey: string): ConfigValue {
  // A generic editor cannot invent configuration owned by an extension. The
  // extension-specific editor, when one exists, supplies its own initial value.
  return {}
}
</script>

<template>
  <article class="editor">
    <header class="editor__header">
      <div>
        <p>{{ t('settings.navigation.configuration') }} // {{ props.section.key.toUpperCase() }}</p>
        <h2>{{ title }}</h2>
        <span>{{ t(props.definition.description) }}</span>
      </div>
      <div class="editor__badges" :aria-label="t('settings.editor.metadata')">
        <span>{{ sourceName }}</span>
        <span v-if="props.section.applies === 'restart'" class="editor__badge--restart">
          {{ t('settings.editor.appliesOnRestart') }}
        </span>
        <span v-else>{{ t('settings.editor.hotApply') }}</span>
      </div>
    </header>

    <div class="editor__content">
      <NoxNotice
        v-if="settings.mutation.type === 'saved'"
        :title="t('settings.editor.saved')"
        :tone="settings.mutation.restartRequired ? 'warning' : 'info'"
      >
        <p v-if="settings.mutation.restartRequired">
          {{ t('settings.editor.savedRestart') }}
        </p>
        <p v-else>{{ t('settings.editor.savedImmediate') }}</p>
      </NoxNotice>

      <NoxNotice
        v-else-if="settings.mutation.type === 'failed'"
        :title="t('settings.editor.changeRefused')"
        tone="danger"
      >
        <p>{{ settings.mutation.message }}</p>
      </NoxNotice>

      <NoxTextField
        v-if="props.creating"
        id="settings-entry-id"
        v-model="entryIdInput"
        :error="entryIdError"
        :hint="t('settings.editor.entryIdHint')"
        :label="t('settings.editor.entryId')"
        placeholder="example-id"
        required
      />

      <section class="editor__group" aria-labelledby="json-editor-title">
        <div class="editor__group-copy">
          <p>{{ t('settings.editor.advancedSurface') }}</p>
          <h3 id="json-editor-title">{{ t('settings.editor.configurationJson') }}</h3>
          <span>{{ t('settings.editor.configurationJsonHelp') }}</span>
        </div>

        <div class="editor__json-field">
          <div class="editor__json-label">
            <label for="settings-json">{{ t('settings.editor.jsonObject') }}</label>
            <button type="button" @click="formatSource()">
              {{ t('settings.editor.formatDocument') }}
            </button>
          </div>
          <textarea
            id="settings-json"
            v-model="source"
            :aria-invalid="sourceError !== undefined"
            :aria-describedby="sourceError === undefined ? undefined : 'settings-json-error'"
            spellcheck="false"
            @input="settings.clearMutation()"
          ></textarea>
          <p v-if="sourceError !== undefined" id="settings-json-error" class="editor__error">
            {{ sourceError }}
          </p>
        </div>
      </section>

      <NoxNotice
        v-if="confirmingDelete"
        :title="t('settings.editor.removeEntryQuestion')"
        tone="danger"
      >
        <div class="editor__delete-confirmation">
          <p>
            {{ t('settings.editor.removeEntryReference', { entry: props.entryId ?? '' }) }}
          </p>
          <div>
            <NoxButton variant="ghost" @click="confirmingDelete = false">{{
              t('common.cancel')
            }}</NoxButton>
            <NoxButton :busy="settings.mutation.type === 'saving'" @click="remove()">
              {{ t('settings.editor.removeEntry') }}
            </NoxButton>
          </div>
        </div>
      </NoxNotice>
    </div>

    <footer class="editor__actions">
      <NoxButton
        v-if="props.entryId !== undefined && !props.creating"
        variant="ghost"
        @click="confirmingDelete = true"
      >
        {{ t('settings.editor.removeNamed', { entry: t(props.definition.label) }) }}
      </NoxButton>
      <span v-else></span>
      <div>
        <span v-if="dirty" class="editor__dirty">{{ t('settings.editor.unsavedChanges') }}</span>
        <NoxButton :disabled="!dirty" variant="secondary" @click="resetEditor()">{{
          t('common.discard')
        }}</NoxButton>
        <NoxButton
          :busy="settings.mutation.type === 'saving'"
          :disabled="!dirty && !props.creating"
          @click="save()"
        >
          {{ t('settings.editor.saveChanges') }}
        </NoxButton>
      </div>
    </footer>
  </article>
</template>

<style scoped lang="scss">
.editor {
  display: grid;
  min-height: 100%;
  grid-template-rows: auto 1fr auto;
}

.editor__header {
  display: flex;
  min-height: 7.5rem;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-8);
  padding: var(--nox-space-6) var(--nox-space-8);
  border-bottom: 1px solid var(--nox-border-subtle);
  background: var(--nox-canvas-raised);
}

.editor__header p,
.editor__header span,
.editor__group-copy p,
.editor__group-copy span {
  margin: 0;
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: 0.07em;
}

.editor__header h2 {
  margin: var(--nox-space-1) 0 var(--nox-space-2);
  font-size: clamp(1.35rem, 3vw, 2rem);
  line-height: var(--nox-leading-tight);
}

.editor__badges {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--nox-space-2);
}

.editor__badges span {
  padding: var(--nox-space-2) var(--nox-space-3);
  border: 1px solid var(--nox-border-subtle);
  color: var(--nox-text-secondary);
  background: var(--nox-surface-1);
  font-size: 0.62rem;
}

.editor__badges .editor__badge--restart {
  border-color: color-mix(in srgb, var(--nox-status-warning) 45%, var(--nox-border-subtle));
  color: var(--nox-status-warning);
}

.editor__content {
  display: grid;
  width: min(100%, 64rem);
  align-content: start;
  gap: var(--nox-space-6);
  justify-self: center;
  padding: var(--nox-space-8);
}

.editor__group {
  display: grid;
  grid-template-columns: minmax(12rem, 0.38fr) minmax(0, 1fr);
  gap: var(--nox-space-8);
  padding: var(--nox-space-6) 0;
  border-top: 1px solid var(--nox-border-subtle);
  border-bottom: 1px solid var(--nox-border-subtle);
}

.editor__group-copy h3 {
  margin: var(--nox-space-2) 0;
  font-size: var(--nox-text-md);
}

.editor__group-copy span {
  display: block;
  max-width: 23rem;
  letter-spacing: 0;
  line-height: 1.65;
}

.editor__json-field {
  display: grid;
  min-width: 0;
  gap: var(--nox-space-2);
}

.editor__json-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-4);
  color: var(--nox-text-secondary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  font-weight: 700;
  letter-spacing: var(--nox-tracking-system);
  text-transform: uppercase;
}

.editor__json-label button {
  padding: var(--nox-space-1) var(--nox-space-2);
  color: var(--nox-text-muted);
  background: transparent;
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  cursor: pointer;
}

.editor__json-label button:hover {
  color: var(--nox-action-primary);
}

.editor__json-field textarea {
  width: 100%;
  min-height: 28rem;
  resize: vertical;
  padding: var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  color: var(--nox-code-inline);
  background: var(--nox-surface-input);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-sm);
  line-height: 1.65;
  tab-size: 2;
  caret-color: var(--nox-action-primary);
}

.editor__json-field textarea:focus {
  border-color: var(--nox-action-primary);
  outline: none;
  box-shadow: 0 0 0 1px var(--nox-action-primary);
}

.editor__json-field textarea[aria-invalid='true'] {
  border-color: var(--nox-status-danger);
}

.editor__error {
  margin: 0;
  color: var(--nox-status-danger);
  font-size: var(--nox-text-xs);
}

.editor__delete-confirmation {
  display: grid;
  gap: var(--nox-space-3);
}

.editor__delete-confirmation > div {
  display: flex;
  justify-content: flex-end;
  gap: var(--nox-space-2);
}

.editor__delete-confirmation code {
  color: var(--nox-text-primary);
}

.editor__actions {
  display: flex;
  min-height: 5rem;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-4);
  padding: var(--nox-space-4) var(--nox-space-8);
  border-top: 1px solid var(--nox-border-subtle);
  background: color-mix(in srgb, var(--nox-canvas-raised) 96%, transparent);
}

.editor__actions > div {
  display: flex;
  align-items: center;
  gap: var(--nox-space-3);
}

.editor__dirty {
  color: var(--nox-status-warning);
  font-family: var(--nox-font-mono);
  font-size: 0.62rem;
  letter-spacing: 0.08em;
}

@media (max-width: 60rem) {
  .editor__header,
  .editor__content,
  .editor__actions {
    padding-inline: var(--nox-space-5);
  }

  .editor__group {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 36rem) {
  .editor__header {
    align-items: flex-start;
    flex-direction: column;
  }

  .editor__badges {
    justify-content: flex-start;
  }

  .editor__actions,
  .editor__actions > div {
    align-items: stretch;
    flex-direction: column;
  }

  .editor__actions > span:empty {
    display: none;
  }
}
</style>
