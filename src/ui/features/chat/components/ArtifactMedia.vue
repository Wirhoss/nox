<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { useAuthStore } from '@/app/stores/auth.store'
import { useI18n } from '@/shared/i18n'

import { readArtifact } from '../api/artifact.api'
import { useActiveSessionStore } from '../stores/activeSession.store'

import type { ChatMediaPart } from '../api/chat.schemas'

interface Props {
  part: ChatMediaPart
}

const props = defineProps<Props>()
const auth = props.part.type === 'artifact' ? useAuthStore() : undefined
const session = props.part.type === 'artifact' ? useActiveSessionStore() : undefined
const { t } = useI18n()
const host = ref<HTMLElement>()
const loadedUrl = ref<string>()
const failed = ref(false)
const loading = ref(false)
let mounted = false
let objectUrl: string | undefined
let observer: IntersectionObserver | undefined
let pending: Promise<string | undefined> | undefined
let version = 0

const artifact = computed(() => (props.part.type === 'artifact' ? props.part.artifact : undefined))
const mediaType = computed(() =>
  props.part.type === 'artifact' ? props.part.artifact.mediaType : props.part.source.mediaType,
)
const kind = computed(() => {
  if (props.part.type !== 'artifact') return props.part.type
  const type = props.part.artifact.mediaType
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('audio/')) return 'audio'
  if (type.startsWith('video/')) return 'video'
  return 'document'
})
const filename = computed(() => artifact.value?.filename ?? artifact.value?.artifactId)
const url = computed(() =>
  props.part.type === 'artifact' ? loadedUrl.value : props.part.source.url,
)

function revoke(): void {
  if (objectUrl === undefined) return
  URL.revokeObjectURL(objectUrl)
  objectUrl = undefined
}

async function performLoad(): Promise<string | undefined> {
  const artifactId = artifact.value?.artifactId
  const accessToken = auth?.accessToken
  if (artifactId === undefined) return undefined
  if (accessToken === undefined) {
    failed.value = true
    return undefined
  }

  const requestedVersion = version
  loading.value = true
  failed.value = false
  try {
    const blob = await readArtifact(artifactId, accessToken, session?.conversationId)
    if (requestedVersion !== version) return undefined
    objectUrl = URL.createObjectURL(blob)
    loadedUrl.value = objectUrl
    return objectUrl
  } catch {
    if (requestedVersion === version) failed.value = true
    return undefined
  } finally {
    if (requestedVersion === version) loading.value = false
  }
}

function loadArtifact(): Promise<string | undefined> {
  if (loadedUrl.value !== undefined) return Promise.resolve(loadedUrl.value)
  if (pending !== undefined) return pending

  const task = performLoad()
  pending = task
  void task.finally(() => {
    if (pending === task) pending = undefined
  })
  return task
}

async function downloadArtifact(): Promise<void> {
  const loaded = await loadArtifact()
  if (loaded === undefined) return
  const anchor = document.createElement('a')
  anchor.href = loaded
  anchor.download = filename.value ?? 'artifact'
  anchor.click()
}

function openPending(): void {
  if (kind.value === 'document') void downloadArtifact()
  else void loadArtifact()
}

function retry(): void {
  openPending()
}

async function observeImage(): Promise<void> {
  if (!mounted || artifact.value === undefined || kind.value !== 'image') return
  await nextTick()
  const element = host.value
  if (element === undefined || !('IntersectionObserver' in window)) {
    void loadArtifact()
    return
  }

  observer ??= new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return
    observer?.disconnect()
    void loadArtifact()
  })
  observer.disconnect()
  observer.observe(element)
}

watch(
  () => [artifact.value?.artifactId, session?.conversationId] as const,
  () => {
    version += 1
    observer?.disconnect()
    pending = undefined
    revoke()
    loadedUrl.value = undefined
    failed.value = false
    loading.value = false
    void observeImage()
  },
  { immediate: true },
)

onMounted(() => {
  mounted = true
  void observeImage()
})

onBeforeUnmount(() => {
  mounted = false
  version += 1
  observer?.disconnect()
  revoke()
})
</script>

<template>
  <button
    v-if="failed && props.part.type === 'artifact'"
    ref="host"
    class="artifact artifact--failed"
    type="button"
    @click="retry"
  >
    {{ filename ?? t('common.unavailable') }}
  </button>
  <span v-else-if="failed" ref="host" class="artifact artifact--failed">
    {{ filename ?? t('common.unavailable') }}
  </span>
  <span
    v-else-if="url === undefined && kind === 'image'"
    ref="host"
    class="artifact artifact--loading"
    :aria-busy="loading"
  >
    {{ filename ?? '…' }}
  </span>
  <button
    v-else-if="url === undefined"
    ref="host"
    class="artifact artifact--pending"
    type="button"
    :aria-busy="loading"
    :disabled="loading"
    @click="openPending"
  >
    {{ filename ?? mediaType ?? t('chat.message.openDocument') }}
  </button>
  <img
    v-else-if="kind === 'image'"
    ref="host"
    class="artifact artifact--image"
    :src="url"
    :alt="filename ?? t('chat.message.attachedImage')"
    loading="lazy"
  />
  <audio
    v-else-if="kind === 'audio'"
    ref="host"
    class="artifact artifact--audio"
    :src="url"
    controls
    preload="metadata"
  >
    {{ t('chat.message.attachedAudio') }}
  </audio>
  <video
    v-else-if="kind === 'video'"
    ref="host"
    class="artifact artifact--video"
    :src="url"
    controls
    preload="metadata"
  >
    {{ t('chat.message.attachedVideo') }}
  </video>
  <a
    v-else
    ref="host"
    class="artifact artifact--document"
    :href="url"
    :download="filename"
    :target="props.part.type === 'artifact' ? undefined : '_blank'"
    rel="noopener noreferrer"
  >
    {{ filename ?? mediaType ?? t('chat.message.openDocument') }}
  </a>
</template>

<style scoped lang="scss">
.artifact--image,
.artifact--video {
  display: block;
  max-width: 100%;
  max-height: 28rem;
  object-fit: contain;
}

.artifact--audio {
  width: 100%;
}

.artifact--document,
.artifact--failed,
.artifact--loading,
.artifact--pending {
  display: inline-flex;
  min-height: 2.5rem;
  align-items: center;
  padding: var(--nox-space-2) var(--nox-space-3);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  color: inherit;
  background: transparent;
  font: inherit;
  text-align: start;
  overflow-wrap: anywhere;
}

button.artifact {
  cursor: pointer;
}

button.artifact:disabled {
  cursor: wait;
}

.artifact--failed {
  color: var(--nox-status-danger);
}

.artifact--loading,
.artifact--pending {
  color: var(--nox-text-muted);
}
</style>
