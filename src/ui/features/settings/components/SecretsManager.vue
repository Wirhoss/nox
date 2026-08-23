<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, RouterLink } from 'vue-router'

import { useI18n } from '@/shared/i18n'
import { NoxButton } from '@/shared/ui/NoxButton'
import { NoxNotice } from '@/shared/ui/NoxNotice'
import { NoxTextField } from '@/shared/ui/NoxTextField'

import { useSettingsStore } from '../stores/settings.store'

import type { SettingsSectionDefinition } from '../model/sections'

interface Props {
  creating?: boolean
  definition: SettingsSectionDefinition
  secretId?: string
}

const props = withDefaults(defineProps<Props>(), {
  creating: false,
  secretId: undefined,
})
const emit = defineEmits<{ created: [secretId: string]; deleted: [] }>()
const settings = useSettingsStore()
const { formatDate: localizeDate, plural, t } = useI18n()
const secretIdInput = ref('')
const value = ref('')
const secretIdError = ref<string>()
const valueError = ref<string>()
const confirmingDelete = ref(false)
const selectedSecret = computed(() =>
  settings.secrets.find((secret) => secret.secretId === props.secretId),
)
/**
 * A listed secret is not a stored one. Extensions declare the IDs they need, so
 * this list contains credentials nobody has supplied yet — which is the reason
 * they are listed at all — and every "does this exist" question has to ask about
 * the value rather than about the row.
 */
const selectedSecretStored = computed(() => selectedSecret.value?.stored === true)
const editing = computed(() => props.creating || props.secretId !== undefined)

watch([() => props.creating, () => props.secretId], () => {
  reset()
})

function reset(): void {
  secretIdInput.value = ''
  value.value = ''
  secretIdError.value = undefined
  valueError.value = undefined
  confirmingDelete.value = false
}

async function save(): Promise<void> {
  secretIdError.value = undefined
  valueError.value = undefined

  const secretId = props.creating ? secretIdInput.value.trim() : props.secretId
  if (secretId === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(secretId)) {
    secretIdError.value = t('settings.validation.secretId')
    return
  }
  if (value.value.length === 0) {
    valueError.value = t('settings.secrets.valueRequired')
    return
  }

  if (await settings.saveSecret(secretId, value.value)) {
    value.value = ''
    if (props.creating) emit('created', secretId)
  }
}

async function remove(): Promise<void> {
  if (props.secretId === undefined) return
  if (await settings.deleteSecret(props.secretId)) emit('deleted')
}

function canLeave(): boolean {
  return value.value.length === 0 || window.confirm(t('settings.confirm.discardSecret'))
}

onBeforeRouteLeave(canLeave)
onBeforeRouteUpdate(canLeave)

function formatDate(timestamp: number | undefined): string {
  if (timestamp === undefined) return t('settings.secrets.notStored')
  return localizeDate(timestamp, { dateStyle: 'medium', timeStyle: 'short' })
}

/** Why this ID is known: configuration names it, someone stored it, or both. */
function origin(references: readonly { readonly location: string }[]): string {
  if (references.length === 0) return t('settings.secrets.originUnreferenced')
  if (references.length === 1) {
    return t('settings.secrets.originOne', { location: references[0]?.location ?? '' })
  }
  return t('settings.secrets.originMany', { count: references.length })
}
</script>

<template>
  <article class="secrets">
    <header class="secrets__header">
      <div>
        <p>{{ t('settings.secrets.managed') }}</p>
        <h2>
          {{
            props.creating
              ? t('settings.secrets.new')
              : (props.secretId ?? t(props.definition.plural))
          }}
        </h2>
        <span>{{ t(props.definition.description) }}</span>
      </div>
      <RouterLink
        v-if="!props.creating"
        class="secrets__create"
        :to="{ name: 'settings', params: { section: 'secrets' }, query: { create: '1' } }"
      >
        + {{ t('settings.secrets.new') }}
      </RouterLink>
    </header>

    <div class="secrets__content">
      <NoxNotice
        v-if="settings.mutation.type === 'saved'"
        :title="t('settings.secrets.storedTitle')"
        :tone="settings.mutation.restartRequired ? 'warning' : 'info'"
      >
        <p v-if="settings.mutation.restartRequired">
          {{ t('settings.secrets.storedRestart') }}
        </p>
        <p v-else>{{ t('settings.secrets.valueAccepted') }}</p>
      </NoxNotice>

      <NoxNotice
        v-else-if="settings.mutation.type === 'failed'"
        :title="t('settings.secrets.operationRefused')"
        tone="danger"
      >
        <p>{{ settings.mutation.message }}</p>
      </NoxNotice>

      <template v-if="editing">
        <section class="secrets__editor">
          <div class="secrets__group-copy">
            <p>{{ t('settings.secrets.writeOnly') }}</p>
            <h3>
              {{
                selectedSecretStored
                  ? t('settings.secrets.replaceCredential')
                  : t('settings.secrets.storeCredential')
              }}
            </h3>
            <span>{{ t('settings.secrets.writeOnlyHelp') }}</span>
          </div>

          <div class="secrets__fields">
            <NoxTextField
              v-if="props.creating"
              id="secret-id"
              v-model="secretIdInput"
              :error="secretIdError"
              :hint="t('settings.secrets.idHint')"
              :label="t('settings.secrets.id')"
              placeholder="OPENAI_API_KEY"
              required
            />
            <div v-else class="secrets__stored-id">
              <span>{{ t('settings.secrets.id') }}</span>
              <strong>{{ props.secretId }}</strong>
            </div>
            <NoxTextField
              id="secret-value"
              v-model="value"
              autocomplete="new-password"
              :error="valueError"
              :hint="t('settings.secrets.blankHint')"
              :label="t('settings.secrets.newValue')"
              :placeholder="t('settings.secrets.valuePlaceholder')"
              required
              type="password"
              @input="settings.clearMutation()"
            />
          </div>
        </section>

        <section v-if="selectedSecret !== undefined" class="secrets__metadata">
          <div>
            <span>{{ t('settings.secrets.created') }}</span>
            <strong>{{ formatDate(selectedSecret.createdAt) }}</strong>
          </div>
          <div>
            <span>{{ t('settings.secrets.updated') }}</span>
            <strong>{{ formatDate(selectedSecret.updatedAt) }}</strong>
          </div>
          <div>
            <span>{{ t('settings.secrets.consumers') }}</span>
            <strong>{{ selectedSecret.consumers.length }}</strong>
          </div>
          <div>
            <span>{{ t('settings.secrets.storeStatus') }}</span>
            <strong :class="{ secrets__missing: !selectedSecretStored }">
              {{
                selectedSecretStored ? t('settings.secrets.stored') : t('settings.secrets.notSet')
              }}
            </strong>
          </div>
        </section>

        <section
          v-if="selectedSecret !== undefined && selectedSecret.references.length > 0"
          class="secrets__consumers"
        >
          <div class="secrets__group-copy">
            <p>{{ t('settings.secrets.configuredReferences') }}</p>
            <h3>{{ t('settings.secrets.usedBy') }}</h3>
            <span>{{ t('settings.secrets.configuredReferencesHelp') }}</span>
          </div>
          <div class="secrets__consumer-list">
            <div v-for="usage in selectedSecret.references" :key="usage.location">
              <span>{{ usage.location }}</span>
            </div>
          </div>
        </section>

        <section v-if="selectedSecret !== undefined" class="secrets__consumers">
          <div class="secrets__group-copy">
            <p>{{ t('settings.secrets.runtimeReferences') }}</p>
            <h3>{{ t('settings.secrets.consumers') }}</h3>
            <span>{{ t('settings.secrets.runtimeReferencesHelp') }}</span>
          </div>
          <div v-if="selectedSecret.consumers.length > 0" class="secrets__consumer-list">
            <div v-for="consumer in selectedSecret.consumers" :key="consumer.location">
              <span>{{ consumer.location }}</span>
              <small>{{ consumer.extensionId }}</small>
            </div>
          </div>
          <p v-else class="secrets__unreferenced">
            {{ t('settings.secrets.noRunningConsumer') }}
          </p>
        </section>

        <NoxNotice
          v-if="confirmingDelete"
          :title="t('settings.secrets.deleteQuestion')"
          tone="danger"
        >
          <div class="secrets__delete-confirmation">
            <p>
              {{ t('settings.secrets.deleteWarning') }}
            </p>
            <p v-if="selectedSecret !== undefined && selectedSecret.references.length > 0">
              {{ plural('settings.secrets.referencesRemain', selectedSecret.references.length) }}
            </p>
            <div>
              <NoxButton variant="ghost" @click="confirmingDelete = false">{{
                t('common.cancel')
              }}</NoxButton>
              <NoxButton :busy="settings.mutation.type === 'saving'" @click="remove()">
                {{ t('settings.secrets.delete') }}
              </NoxButton>
            </div>
          </div>
        </NoxNotice>
      </template>

      <template v-else>
        <section
          v-if="settings.secrets.length > 0"
          class="secrets__list"
          :aria-label="t(props.definition.plural)"
        >
          <RouterLink
            v-for="secret in settings.secrets"
            :key="secret.secretId"
            class="secrets__row"
            :to="{
              name: 'settings',
              params: { entryId: secret.secretId, section: 'secrets' },
            }"
          >
            <span
              class="secrets__marker"
              :class="{ 'secrets__marker--missing': !secret.stored }"
              aria-hidden="true"
            ></span>
            <div>
              <strong>{{ secret.secretId }}</strong>
              <span>
                {{ origin(secret.references) }} ·
                {{
                  secret.stored
                    ? t('settings.secrets.updatedAt', { date: formatDate(secret.updatedAt) })
                    : t('settings.secrets.awaitingValue')
                }}
              </span>
            </div>
            <small :class="{ 'secrets__in-use': secret.stored, secrets__missing: !secret.stored }">
              {{ secret.stored ? t('settings.secrets.stored') : t('settings.secrets.notSet') }}
            </small>
          </RouterLink>
        </section>

        <section v-else class="secrets__empty">
          <span aria-hidden="true">◇</span>
          <div>
            <h3>{{ t('settings.secrets.noneKnown') }}</h3>
            <p>{{ t('settings.secrets.noneKnownHelp') }}</p>
          </div>
        </section>
      </template>
    </div>

    <footer v-if="editing" class="secrets__actions">
      <NoxButton v-if="selectedSecretStored" variant="ghost" @click="confirmingDelete = true">
        {{ t('settings.secrets.delete') }}
      </NoxButton>
      <span v-else></span>
      <div>
        <NoxButton :disabled="value.length === 0" variant="secondary" @click="reset()">
          {{ t('common.discard') }}
        </NoxButton>
        <NoxButton
          :busy="settings.mutation.type === 'saving'"
          :disabled="value.length === 0"
          @click="save()"
        >
          {{
            selectedSecretStored ? t('settings.secrets.replaceValue') : t('settings.secrets.store')
          }}
        </NoxButton>
      </div>
    </footer>
  </article>
</template>

<style scoped lang="scss">
.secrets {
  display: grid;
  min-height: 100%;
  grid-template-rows: auto 1fr auto;
}

.secrets__header {
  display: flex;
  min-height: 7.5rem;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-8);
  padding: var(--nox-space-6) var(--nox-space-8);
  border-bottom: 1px solid var(--nox-border-subtle);
  background: var(--nox-canvas-raised);
}

.secrets__header p,
.secrets__header span,
.secrets__group-copy p,
.secrets__group-copy span,
.secrets__stored-id span,
.secrets__metadata span {
  margin: 0;
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: 0.07em;
}

.secrets__header h2 {
  margin: var(--nox-space-1) 0 var(--nox-space-2);
  font-size: clamp(1.35rem, 3vw, 2rem);
  line-height: var(--nox-leading-tight);
}

.secrets__create {
  display: inline-flex;
  min-height: var(--nox-control-height);
  align-items: center;
  padding: 0 var(--nox-space-5);
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-inverse);
  background: var(--nox-action-primary);
  box-shadow: var(--nox-glow-operational);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-sm);
  font-weight: 700;
  text-decoration: none;
}

.secrets__content {
  display: grid;
  width: min(100%, 64rem);
  align-content: start;
  gap: var(--nox-space-6);
  justify-self: center;
  padding: var(--nox-space-8);
}

.secrets__editor,
.secrets__consumers {
  display: grid;
  grid-template-columns: minmax(12rem, 0.38fr) minmax(0, 1fr);
  gap: var(--nox-space-8);
  padding: var(--nox-space-6) 0;
  border-top: 1px solid var(--nox-border-subtle);
  border-bottom: 1px solid var(--nox-border-subtle);
}

.secrets__group-copy h3 {
  margin: var(--nox-space-2) 0;
  font-size: var(--nox-text-md);
}

.secrets__group-copy span {
  display: block;
  max-width: 23rem;
  letter-spacing: 0;
  line-height: 1.65;
}

.secrets__fields {
  display: grid;
  gap: var(--nox-space-5);
}

.secrets__stored-id {
  display: grid;
  gap: var(--nox-space-2);
}

.secrets__stored-id strong {
  min-height: var(--nox-control-height);
  padding: var(--nox-space-3) var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  color: var(--nox-text-secondary);
  background: var(--nox-surface-1);
  font-family: var(--nox-font-mono);
  overflow-wrap: anywhere;
}

.secrets__metadata {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  border: 1px solid var(--nox-border-subtle);
  background: var(--nox-surface-1);
}

.secrets__metadata > div {
  display: grid;
  gap: var(--nox-space-2);
  padding: var(--nox-space-4);
}

.secrets__metadata > div + div {
  border-inline-start: 1px solid var(--nox-border-subtle);
}

.secrets__metadata strong {
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-sm);
  font-weight: 500;
}

.secrets__consumer-list {
  display: grid;
  border-top: 1px solid var(--nox-border-subtle);
}

.secrets__consumer-list > div {
  display: grid;
  gap: var(--nox-space-1);
  padding: var(--nox-space-3);
  border-bottom: 1px solid var(--nox-border-subtle);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-sm);
}

.secrets__consumer-list small,
.secrets__unreferenced {
  color: var(--nox-text-muted);
  font-size: var(--nox-text-xs);
}

.secrets__unreferenced {
  margin: 0;
  padding: var(--nox-space-4);
  border: 1px dashed var(--nox-border-strong);
}

.secrets__list {
  display: grid;
  border-top: 1px solid var(--nox-border-subtle);
}

.secrets__row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--nox-space-4);
  padding: var(--nox-space-5) var(--nox-space-4);
  border-bottom: 1px solid var(--nox-border-subtle);
  color: var(--nox-text-primary);
  text-decoration: none;
}

.secrets__row:hover {
  background: var(--nox-surface-hover);
}

.secrets__marker {
  width: 0.55rem;
  height: 0.55rem;
  border: 1px solid var(--nox-status-info);
  transform: rotate(45deg);
}

.secrets__row > div {
  display: grid;
  min-width: 0;
  gap: var(--nox-space-1);
}

.secrets__row strong,
.secrets__row span,
.secrets__row small {
  font-family: var(--nox-font-mono);
}

.secrets__row strong {
  overflow-wrap: anywhere;
}

.secrets__row > div span,
.secrets__row small {
  color: var(--nox-text-muted);
  font-size: var(--nox-text-xs);
}

.secrets__row .secrets__in-use {
  color: var(--nox-status-success);
}

.secrets__missing {
  color: var(--nox-status-warning);
}

.secrets__marker--missing {
  border-color: var(--nox-status-warning);
}

.secrets__empty {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--nox-space-4);
  padding: var(--nox-space-8);
  border: 1px dashed var(--nox-border-strong);
  color: var(--nox-text-muted);
}

.secrets__empty > span {
  color: var(--nox-status-info);
  font-size: 1.5rem;
}

.secrets__empty h3,
.secrets__empty p {
  margin: 0;
}

.secrets__empty h3 {
  color: var(--nox-text-primary);
  font-size: var(--nox-text-md);
}

.secrets__empty p {
  margin-top: var(--nox-space-2);
  font-size: var(--nox-text-sm);
}

.secrets__delete-confirmation {
  display: grid;
  gap: var(--nox-space-3);
}

.secrets__delete-confirmation > div {
  display: flex;
  justify-content: flex-end;
  gap: var(--nox-space-2);
}

.secrets__actions {
  display: flex;
  min-height: 5rem;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-4);
  padding: var(--nox-space-4) var(--nox-space-8);
  border-top: 1px solid var(--nox-border-subtle);
  background: color-mix(in srgb, var(--nox-canvas-raised) 96%, transparent);
}

.secrets__actions > div {
  display: flex;
  gap: var(--nox-space-3);
}

@media (max-width: 60rem) {
  .secrets__header,
  .secrets__content,
  .secrets__actions {
    padding-inline: var(--nox-space-5);
  }

  .secrets__editor,
  .secrets__consumers {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 36rem) {
  .secrets__header,
  .secrets__actions,
  .secrets__actions > div {
    align-items: stretch;
    flex-direction: column;
  }

  .secrets__metadata {
    grid-template-columns: 1fr;
  }

  .secrets__metadata > div + div {
    border-top: 1px solid var(--nox-border-subtle);
    border-inline-start: 0;
  }
}
</style>
