<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { useAuthStore } from '@/app/stores/auth.store'
import { useI18n } from '@/shared/i18n'

import { readArtifact } from '../api/artifact.api'

import type { ChatMediaPart } from '../api/chat.schemas'

interface Props {
  part: ChatMediaPart
}

const props = defineProps<Props>()
const auth = props.part.type === 'artifact' ? useAuthStore() : undefined
const { t } = useI18n()
const loadedUrl = ref<string>()
const failed = ref(false)
let objectUrl: string | undefined
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

watch(
  () => artifact.value?.artifactId,
  async (artifactId) => {
    version += 1
    const loading = version
    revoke()
    loadedUrl.value = undefined
    failed.value = false
    if (artifactId === undefined) return

    const accessToken = auth?.accessToken
    if (accessToken === undefined) {
      failed.value = true
      return
    }

    try {
      const blob = await readArtifact(artifactId, accessToken)
      if (loading !== version) return
      objectUrl = URL.createObjectURL(blob)
      loadedUrl.value = objectUrl
    } catch {
      if (loading === version) failed.value = true
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  version += 1
  revoke()
})
</script>

<template>
  <span v-if="failed" class="artifact artifact--failed">{{ filename ?? t('common.unavailable') }}</span>
  <span v-else-if="url === undefined" class="artifact artifact--loading">{{ filename ?? '…' }}</span>
  <img
    v-else-if="kind === 'image'"
    class="artifact artifact--image"
    :src="url"
    :alt="filename ?? t('chat.message.attachedImage')"
    loading="lazy"
  />
  <audio
    v-else-if="kind === 'audio'"
    class="artifact artifact--audio"
    :src="url"
    controls
    preload="metadata"
  >
    {{ t('chat.message.attachedAudio') }}
  </audio>
  <video
    v-else-if="kind === 'video'"
    class="artifact artifact--video"
    :src="url"
    controls
    preload="metadata"
  >
    {{ t('chat.message.attachedVideo') }}
  </video>
  <a
    v-else
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
.artifact--loading {
  display: inline-flex;
  min-height: 2.5rem;
  align-items: center;
  padding: var(--nox-space-2) var(--nox-space-3);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  overflow-wrap: anywhere;
}

.artifact--failed {
  color: var(--nox-status-danger);
}

.artifact--loading {
  color: var(--nox-text-muted);
}
</style>
