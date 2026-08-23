<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

import { useI18n } from '@/shared/i18n'
import { NoxButton } from '@/shared/ui/NoxButton'

import { useActiveSessionStore } from '../stores/activeSession.store'
import ContextGauge from './ContextGauge.vue'

import type { ChatContentPart, ChatMediaPart } from '../api/chat.schemas'

const MAX_ATTACHMENTS = 4
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
const SUPPORTED_IMAGE_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp'])

const session = useActiveSessionStore()
const { t } = useI18n()
const text = ref('')
const attachments = ref<ChatMediaPart[]>([])
const attachmentError = ref<string>()
const fileInput = ref<HTMLInputElement>()
const commandError = ref<string>()
const commandPicker = ref<HTMLElement>()
const commandSearch = ref<HTMLInputElement>()
const commandQuery = ref('')
const commandsOpen = ref(false)
const filteredCommands = computed(() => {
  const query = commandQuery.value.trim().toLocaleLowerCase()
  if (query.length === 0) return session.commands
  return session.commands.filter(
    (command) =>
      command.name.toLocaleLowerCase().includes(query) ||
      command.description.toLocaleLowerCase().includes(query),
  )
})
const canSubmit = computed(
  () => session.canSend && (text.value.trim().length > 0 || attachments.value.length > 0),
)
const buttonLabel = computed(() => {
  if (attachments.value.length === 0 && text.value.trimStart().startsWith('/')) {
    return t('chat.composer.runCommand')
  }
  return session.sendMode === 'steer' ? t('chat.composer.steer') : t('chat.composer.execute')
})
const placeholder = computed(() =>
  session.sendMode === 'steer'
    ? t('chat.composer.steerPlaceholder')
    : t('chat.composer.placeholder'),
)
const status = computed(() => {
  switch (session.run.type) {
    case 'failed':
      return t('chat.run.failed')
    case 'idle':
      return session.connection.type === 'connected'
        ? t('chat.run.ready')
        : t('chat.run.waitingLink')
    case 'running':
      return t('chat.run.workingSteer')
    case 'sending':
      return session.run.mode === 'steer' ? t('chat.run.steering') : t('chat.run.handingMessage')
    case 'waiting-permission':
      return t('chat.run.waitingAuthorization')
  }
  return t('common.unavailable')
})

async function submit(): Promise<void> {
  if (!canSubmit.value) return
  commandError.value = undefined

  const value = text.value.trim()
  if (attachments.value.length === 0 && value.startsWith('/')) {
    const parsed = parseCommand(value)
    if (typeof parsed === 'string') {
      commandError.value = parsed
      return
    }
    if (await session.invokeCommand(parsed.command, parsed.arguments)) text.value = ''
    return
  }

  const content: ChatContentPart[] = [
    ...(value.length === 0 ? [] : [{ text: value, type: 'text' as const }]),
    ...attachments.value,
  ]
  if (await session.sendContent(content)) {
    text.value = ''
    attachments.value = []
    attachmentError.value = undefined
    if (fileInput.value !== undefined) fileInput.value.value = ''
  }
}

async function chooseFiles(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  attachmentError.value = undefined

  for (const file of files) {
    if (attachments.value.length >= MAX_ATTACHMENTS) {
      attachmentError.value = t('chat.attachment.tooMany', { count: MAX_ATTACHMENTS })
      break
    }
    if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
      attachmentError.value = t('chat.attachment.unsupported', { file: file.name })
      continue
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      attachmentError.value = t('chat.attachment.tooLarge', { file: file.name })
      continue
    }

    try {
      attachments.value = [
        ...attachments.value,
        {
          source: { data: await fileBase64(file), mediaType: file.type, type: 'base64' },
          type: 'image',
        },
      ]
    } catch {
      attachmentError.value = t('chat.attachment.couldNotRead', { file: file.name })
    }
  }
  input.value = ''
}

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => {
      reject(reader.error ?? new Error(t('chat.attachment.readError', { file: file.name })))
    }
    reader.onload = () => {
      const value = reader.result
      if (typeof value !== 'string') {
        reject(new Error(t('chat.attachment.encodeError', { file: file.name })))
        return
      }
      resolve(value.slice(value.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}

function attachmentUrl(part: ChatMediaPart): string {
  return part.source.type === 'url'
    ? part.source.url
    : `data:${part.source.mediaType};base64,${part.source.data}`
}

function removeAttachment(index: number): void {
  attachments.value = attachments.value.filter((_, candidate) => candidate !== index)
  attachmentError.value = undefined
}

function chooseCommand(command: string): void {
  text.value = `/${command}`
  commandError.value = undefined
  commandsOpen.value = false
  commandQuery.value = ''
}

async function toggleCommands(): Promise<void> {
  commandsOpen.value = !commandsOpen.value
  if (!commandsOpen.value) return
  await nextTick()
  commandSearch.value?.focus()
}

function closeCommandsOnOutsideClick(event: PointerEvent): void {
  if (
    commandsOpen.value &&
    event.target instanceof Node &&
    commandPicker.value?.contains(event.target) !== true
  ) {
    commandsOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', closeCommandsOnOutsideClick)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', closeCommandsOnOutsideClick)
})

function parseCommand(
  value: string,
): string | { readonly arguments?: Readonly<Record<string, unknown>>; readonly command: string } {
  const match = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]+))?$/.exec(value)
  const command = match?.[1]
  if (command === undefined || !session.commands.some((entry) => entry.name === command)) {
    return t('chat.command.choosePublished')
  }

  const serializedArguments = match?.[2]
  if (serializedArguments === undefined) return { command }

  try {
    const parsed: unknown = JSON.parse(serializedArguments)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return t('chat.command.argumentsObject')
    }
    return { arguments: parsed as Readonly<Record<string, unknown>>, command }
  } catch {
    return t('chat.command.argumentsValidJson')
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  void submit()
}
</script>

<template>
  <div class="composer">
    <p v-if="commandError !== undefined" class="composer__error" role="alert">
      {{ commandError }}
    </p>
    <p v-if="attachmentError !== undefined" class="composer__error" role="alert">
      {{ attachmentError }}
    </p>

    <label class="composer__label" for="chat-message">{{ t('chat.composer.label') }}</label>
    <textarea
      id="chat-message"
      v-model="text"
      class="composer__input"
      name="message"
      rows="3"
      maxlength="32000"
      :placeholder="placeholder"
      @keydown="onKeydown"
    ></textarea>

    <ul
      v-if="attachments.length > 0"
      class="composer__attachments"
      :aria-label="t('chat.attachment.attachments')"
    >
      <li v-for="(part, index) in attachments" :key="index">
        <img :src="attachmentUrl(part)" :alt="t('chat.attachment.preview')" />
        <button
          type="button"
          :aria-label="t('chat.attachment.removeNumber', { number: index + 1 })"
          @click="removeAttachment(index)"
        >
          {{ t('common.remove') }}
        </button>
      </li>
    </ul>

    <footer class="composer__footer">
      <div class="composer__meta">
        <div
          v-if="session.commands.length > 0"
          ref="commandPicker"
          class="composer__command-picker"
          @keydown.esc="commandsOpen = false"
        >
          <button
            class="composer__command-trigger"
            type="button"
            aria-controls="command-picker-menu"
            :aria-expanded="commandsOpen"
            @click="toggleCommands()"
          >
            {{ t('chat.command.commands') }} · {{ session.commands.length }}
          </button>

          <section
            v-if="commandsOpen"
            id="command-picker-menu"
            class="composer__command-menu"
            :aria-label="t('chat.command.available')"
          >
            <label class="composer__command-search">
              <span>{{ t('chat.command.find') }}</span>
              <input
                ref="commandSearch"
                v-model="commandQuery"
                type="search"
                :placeholder="t('chat.command.searchPlaceholder')"
              />
            </label>

            <ul v-if="filteredCommands.length > 0">
              <li v-for="command in filteredCommands" :key="command.name">
                <button type="button" @click="chooseCommand(command.name)">
                  <strong>/{{ command.name }}</strong>
                  <span>{{ command.description }}</span>
                </button>
              </li>
            </ul>
            <p v-else class="composer__command-empty">{{ t('chat.command.noMatches') }}</p>

            <p class="composer__command-help">
              {{ t('chat.command.argumentsHelp') }}
              <code>/command {&quot;key&quot;:&quot;value&quot;}</code>
            </p>
          </section>
        </div>

        <span>{{ t('chat.conversation.web') }}</span>
        <span>{{ status }}</span>
      </div>
      <div class="composer__actions">
        <input
          ref="fileInput"
          class="composer__file-input"
          type="file"
          accept="image/gif,image/jpeg,image/png,image/webp"
          multiple
          @change="chooseFiles"
        />
        <button
          class="composer__attach"
          type="button"
          :disabled="!session.canSend || attachments.length >= MAX_ATTACHMENTS"
          @click="fileInput?.click()"
        >
          {{ t('chat.attachment.attachImage') }}
        </button>
        <ContextGauge :usage="session.contextUsage" />
        <NoxButton :busy="session.run.type === 'sending'" :disabled="!canSubmit" @click="submit()">
          {{ buttonLabel }}
        </NoxButton>
      </div>
    </footer>
  </div>
</template>

<style scoped lang="scss">
.composer {
  border: 1px solid var(--nox-border-strong);
  border-radius: var(--nox-radius-panel);
  background: var(--nox-surface-1);
  box-shadow: var(--nox-shadow-panel);
  overflow: visible;
  transition: border-color var(--nox-motion-fast) var(--nox-ease-out);

  &:focus-within {
    border-color: var(--nox-action-primary);
  }
}

.composer__attachments {
  display: flex;
  flex-wrap: wrap;
  gap: var(--nox-space-3);
  margin: 0;
  padding: 0 var(--nox-space-4) var(--nox-space-3);
  list-style: none;
}

.composer__attachments li {
  position: relative;
  width: 6rem;
  height: 6rem;
}

.composer__attachments img {
  width: 100%;
  height: 100%;
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  object-fit: cover;
}

.composer__attachments button {
  position: absolute;
  top: var(--nox-space-1);
  inset-inline-end: var(--nox-space-1);
  padding: 0.15rem 0.3rem;
  border: 1px solid var(--nox-border-strong);
  color: var(--nox-text-primary);
  background: color-mix(in srgb, var(--nox-canvas) 88%, transparent);
  font-family: var(--nox-font-mono);
  font-size: 0.55rem;
  cursor: pointer;
}

.composer__file-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

.composer__attach {
  padding: var(--nox-space-2) var(--nox-space-3);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-secondary);
  background: transparent;
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  cursor: pointer;
}

.composer__attach:hover:not(:disabled) {
  border-color: var(--nox-action-primary);
  color: var(--nox-action-primary);
}

.composer__attach:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.composer__command-picker {
  position: relative;
  flex: 0 0 auto;
}

.composer__command-trigger {
  padding: 0;
  border: 0;
  color: var(--nox-action-primary);
  background: transparent;
  cursor: pointer;
  font: inherit;
  letter-spacing: inherit;
  text-transform: inherit;
}

.composer__command-trigger:hover {
  color: var(--nox-action-primary-hover);
}

.composer__command-menu {
  position: absolute;
  z-index: var(--nox-layer-overlay);
  bottom: calc(100% + var(--nox-space-3));
  inset-inline-start: 0;
  display: grid;
  width: min(32rem, calc(100vw - var(--nox-space-8)));
  max-height: min(22rem, 52vh);
  grid-template-rows: auto minmax(0, 1fr) auto;
  border: 1px solid var(--nox-border-strong);
  border-radius: var(--nox-radius-panel);
  color: var(--nox-text-secondary);
  background: var(--nox-canvas-raised);
  box-shadow: var(--nox-shadow-panel);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: normal;
  overflow: hidden;
  text-transform: none;
}

.composer__command-search {
  display: grid;
  gap: var(--nox-space-2);
  padding: var(--nox-space-4);
  border-bottom: 1px solid var(--nox-border-subtle);
}

.composer__command-search span {
  color: var(--nox-text-muted);
  font-size: 0.65rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.composer__command-search input {
  width: 100%;
  padding: var(--nox-space-3);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  outline: 0;
  color: var(--nox-text-primary);
  background: var(--nox-surface-input);
  font: inherit;
}

.composer__command-search input:focus {
  border-color: var(--nox-action-primary);
}

.composer__command-menu ul {
  display: grid;
  min-height: 0;
  align-content: start;
  margin: 0;
  padding: var(--nox-space-2);
  list-style: none;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-color: var(--nox-border-strong) transparent;
}

.composer__command-menu li > button {
  display: grid;
  width: 100%;
  gap: var(--nox-space-1);
  padding: var(--nox-space-3);
  border: 1px solid transparent;
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-secondary);
  background: transparent;
  font: inherit;
  text-align: start;
  cursor: pointer;
}

.composer__command-menu li > button:hover,
.composer__command-menu li > button:focus-visible {
  border-color: var(--nox-border-subtle);
  outline: 0;
  background: var(--nox-surface-1);
}

.composer__command-menu strong {
  color: var(--nox-action-primary);
  font-size: var(--nox-text-sm);
}

.composer__command-menu li span {
  color: var(--nox-text-muted);
  line-height: var(--nox-leading-body);
}

.composer__command-empty,
.composer__command-help {
  margin: 0;
  color: var(--nox-text-muted);
}

.composer__command-empty {
  padding: var(--nox-space-5);
  text-align: center;
}

.composer__command-help {
  padding: var(--nox-space-3) var(--nox-space-4);
  border-top: 1px solid var(--nox-border-subtle);
  font-size: 0.65rem;
}

.composer__command-help code {
  color: var(--nox-text-secondary);
}

.composer__error {
  padding: var(--nox-space-2) var(--nox-space-5) 0;
  margin: 0;
  color: var(--nox-status-danger);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.composer__label {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  border: 0;
  margin: -1px;
  clip: rect(0, 0, 0, 0);
  overflow: hidden;
  white-space: nowrap;
}

.composer__input {
  display: block;
  width: 100%;
  min-height: 7rem;
  padding: var(--nox-space-5);
  border: 0;
  outline: 0;
  color: var(--nox-text-primary);
  background: transparent;
  line-height: var(--nox-leading-body);
  resize: vertical;

  &::placeholder {
    color: var(--nox-text-muted);
  }
}

.composer__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-4);
  padding: var(--nox-space-3);
  border-top: 1px solid var(--nox-border-subtle);
  background: var(--nox-canvas-raised);
}

.composer__meta,
.composer__actions {
  display: flex;
  align-items: center;
}

.composer__meta {
  flex-wrap: wrap;
  gap: var(--nox-space-4);
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.composer__actions {
  gap: var(--nox-space-4);
}

@media (max-width: 36rem) {
  .composer__footer {
    align-items: stretch;
    flex-direction: column;
  }

  .composer__meta,
  .composer__actions {
    justify-content: space-between;
  }
}
</style>
