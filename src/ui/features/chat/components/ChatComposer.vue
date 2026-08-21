<script setup lang="ts">
import { computed, ref } from 'vue'

import { NoxButton } from '@/shared/ui/NoxButton'

import { useActiveSessionStore } from '../stores/activeSession.store'

const session = useActiveSessionStore()
const text = ref('')
const canSubmit = computed(() => session.canSend && text.value.trim().length > 0)
const status = computed(() => {
  switch (session.run.type) {
    case 'failed':
      return 'Run failed'
    case 'idle':
      return session.connection.type === 'connected' ? 'Ready' : 'Waiting for link'
    case 'running':
      return 'Nox is working'
    case 'sending':
      return 'Handing message to Nox'
    case 'waiting-permission':
      return 'Waiting for authorization'
  }
  return 'Unavailable'
})

async function submit(): Promise<void> {
  if (!canSubmit.value) return
  if (await session.send(text.value)) text.value = ''
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  void submit()
}
</script>

<template>
  <div class="composer">
    <label class="composer__label" for="chat-message">Tell Nox what needs to be done</label>
    <textarea
      id="chat-message"
      v-model="text"
      class="composer__input"
      name="message"
      rows="3"
      maxlength="32000"
      placeholder="Tell Nox what needs to be done..."
      @keydown="onKeydown"
    ></textarea>

    <footer class="composer__footer">
      <div class="composer__meta">
        <span>WEB CONVERSATION</span>
        <span>{{ status }}</span>
      </div>
      <NoxButton
        :busy="session.run.type === 'sending'"
        :disabled="!canSubmit"
        @click="submit()"
      >
        Execute
      </NoxButton>
    </footer>
  </div>
</template>

<style scoped lang="scss">
.composer {
  border: 1px solid var(--nox-border-strong);
  border-radius: var(--nox-radius-panel);
  background: var(--nox-surface-1);
  box-shadow: var(--nox-shadow-panel);
  overflow: hidden;
  transition: border-color var(--nox-motion-fast) var(--nox-ease-out);

  &:focus-within {
    border-color: var(--nox-action-primary);
  }
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

.composer__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--nox-space-4);
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

@media (max-width: 36rem) {
  .composer__footer {
    align-items: stretch;
    flex-direction: column;
  }

  .composer__meta {
    justify-content: space-between;
  }
}
</style>
