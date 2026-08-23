<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, RouterLink } from 'vue-router'

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
    secretIdError.value =
      'Use up to 128 letters, digits, dots, dashes or underscores, starting with a letter or digit.'
    return
  }
  if (value.value.length === 0) {
    valueError.value = 'A secret value cannot be empty.'
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
  return value.value.length === 0 || window.confirm('Discard the secret value you entered?')
}

onBeforeRouteLeave(canLeave)
onBeforeRouteUpdate(canLeave)

function formatDate(timestamp: number | undefined): string {
  if (timestamp === undefined) return 'NOT STORED'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp))
}

/** Why this ID is known: configuration names it, someone stored it, or both. */
function origin(references: readonly { readonly location: string }[]): string {
  if (references.length === 0) return 'stored, referenced by nothing'
  if (references.length === 1) return `used by ${references[0]?.location ?? ''}`
  return `used by ${String(references.length)} configured entries`
}
</script>

<template>
  <article class="secrets">
    <header class="secrets__header">
      <div>
        <p>SECURITY // MANAGED SECRETS</p>
        <h2>{{ props.creating ? 'New secret' : (props.secretId ?? 'Secrets') }}</h2>
        <span>{{ props.definition.description }}</span>
      </div>
      <RouterLink
        v-if="!props.creating"
        class="secrets__create"
        :to="{ name: 'settings', params: { section: 'secrets' }, query: { create: '1' } }"
      >
        + New secret
      </RouterLink>
    </header>

    <div class="secrets__content">
      <NoxNotice
        v-if="settings.mutation.type === 'saved'"
        title="Secret stored"
        :tone="settings.mutation.restartRequired ? 'warning' : 'info'"
      >
        <p v-if="settings.mutation.restartRequired">
          One or more running consumers retain the previous value until Nox restarts.
        </p>
        <p v-else>The value was accepted.</p>
      </NoxNotice>

      <NoxNotice
        v-else-if="settings.mutation.type === 'failed'"
        title="Secret operation refused"
        tone="danger"
      >
        <p>{{ settings.mutation.message }}</p>
      </NoxNotice>

      <template v-if="editing">
        <section class="secrets__editor">
          <div class="secrets__group-copy">
            <p>WRITE-ONLY VALUE</p>
            <h3>{{ selectedSecretStored ? 'Replace credential' : 'Store credential' }}</h3>
            <span>
              Nox encrypts this value at rest. The browser can write it but no API can retrieve it
              again.
            </span>
          </div>

          <div class="secrets__fields">
            <NoxTextField
              v-if="props.creating"
              id="secret-id"
              v-model="secretIdInput"
              :error="secretIdError"
              hint="Stable reference used in configuration, for example OPENAI_API_KEY."
              label="Secret ID"
              placeholder="OPENAI_API_KEY"
              required
            />
            <div v-else class="secrets__stored-id">
              <span>SECRET ID</span>
              <strong>{{ props.secretId }}</strong>
            </div>
            <NoxTextField
              id="secret-value"
              v-model="value"
              autocomplete="new-password"
              :error="valueError"
              hint="The field is intentionally blank even when a value already exists."
              label="New value"
              placeholder="Value will not be shown again"
              required
              type="password"
              @input="settings.clearMutation()"
            />
          </div>
        </section>

        <section v-if="selectedSecret !== undefined" class="secrets__metadata">
          <div>
            <span>CREATED</span>
            <strong>{{ formatDate(selectedSecret.createdAt) }}</strong>
          </div>
          <div>
            <span>UPDATED</span>
            <strong>{{ formatDate(selectedSecret.updatedAt) }}</strong>
          </div>
          <div>
            <span>CONSUMERS</span>
            <strong>{{ selectedSecret.consumers.length }}</strong>
          </div>
          <div>
            <span>STORE STATUS</span>
            <strong :class="{ secrets__missing: !selectedSecretStored }">
              {{ selectedSecretStored ? 'STORED' : 'NOT SET' }}
            </strong>
          </div>
        </section>

        <section
          v-if="selectedSecret !== undefined && selectedSecret.references.length > 0"
          class="secrets__consumers"
        >
          <div class="secrets__group-copy">
            <p>CONFIGURED REFERENCES</p>
            <h3>Used by</h3>
            <span>
              Every configured entry naming this ID. One value serves all of them, which is what
              reusing a credential across entries looks like.
            </span>
          </div>
          <div class="secrets__consumer-list">
            <div v-for="usage in selectedSecret.references" :key="usage.location">
              <span>{{ usage.location }}</span>
            </div>
          </div>
        </section>

        <section v-if="selectedSecret !== undefined" class="secrets__consumers">
          <div class="secrets__group-copy">
            <p>RUNTIME REFERENCES</p>
            <h3>Consumers</h3>
            <span>Consumers already holding a handle keep their snapshot until restart.</span>
          </div>
          <div v-if="selectedSecret.consumers.length > 0" class="secrets__consumer-list">
            <div v-for="consumer in selectedSecret.consumers" :key="consumer.location">
              <span>{{ consumer.location }}</span>
              <small>{{ consumer.extensionId }}</small>
            </div>
          </div>
          <p v-else class="secrets__unreferenced">
            No running contribution has resolved this secret.
          </p>
        </section>

        <NoxNotice v-if="confirmingDelete" title="Delete managed secret?" tone="danger">
          <div class="secrets__delete-confirmation">
            <p>
              The value cannot be recovered. Running consumers may retain their current snapshot,
              but the next restart will fail if configuration still references this ID.
            </p>
            <p v-if="selectedSecret !== undefined && selectedSecret.references.length > 0">
              The ID stays listed as unset afterwards: {{ selectedSecret.references.length }}
              configured
              {{ selectedSecret.references.length === 1 ? 'entry' : 'entries' }} still name it.
            </p>
            <div>
              <NoxButton variant="ghost" @click="confirmingDelete = false">Cancel</NoxButton>
              <NoxButton :busy="settings.mutation.type === 'saving'" @click="remove()">
                Delete secret
              </NoxButton>
            </div>
          </div>
        </NoxNotice>
      </template>

      <template v-else>
        <section v-if="settings.secrets.length > 0" class="secrets__list" aria-label="Secrets">
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
                {{ secret.stored ? `updated ${formatDate(secret.updatedAt)}` : 'awaiting a value' }}
              </span>
            </div>
            <small :class="{ 'secrets__in-use': secret.stored, secrets__missing: !secret.stored }">
              {{ secret.stored ? 'STORED' : 'NOT SET' }}
            </small>
          </RouterLink>
        </section>

        <section v-else class="secrets__empty">
          <span aria-hidden="true">◇</span>
          <div>
            <h3>No known secrets</h3>
            <p>
              No configuration names a credential and none has been stored. Store one here, then
              reference its ID from a provider, tool set or broker entry.
            </p>
          </div>
        </section>
      </template>
    </div>

    <footer v-if="editing" class="secrets__actions">
      <NoxButton v-if="selectedSecretStored" variant="ghost" @click="confirmingDelete = true">
        Delete secret
      </NoxButton>
      <span v-else></span>
      <div>
        <NoxButton :disabled="value.length === 0" variant="secondary" @click="reset()">
          Discard
        </NoxButton>
        <NoxButton
          :busy="settings.mutation.type === 'saving'"
          :disabled="value.length === 0"
          @click="save()"
        >
          {{ selectedSecretStored ? 'Replace value' : 'Store secret' }}
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
  border-left: 1px solid var(--nox-border-subtle);
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
    padding-right: var(--nox-space-5);
    padding-left: var(--nox-space-5);
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
    border-left: 0;
  }
}
</style>
