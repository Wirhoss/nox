<script setup lang="ts">
import { computed } from 'vue'

import { type AuthState, useAuthStore } from '@/app/stores/auth.store'
import AccessFrame from '@/features/auth/components/AccessFrame.vue'
import LoginForm from '@/features/auth/components/LoginForm.vue'
import RegistrationForm from '@/features/auth/components/RegistrationForm.vue'
import { NoxButton } from '@/shared/ui/NoxButton'
import { NoxNotice } from '@/shared/ui/NoxNotice'

interface FrameCopy {
  readonly description: string
  readonly eyebrow: string
  readonly status: string
  readonly statusTone: 'danger' | 'operational' | 'waiting'
  readonly title: string
}

const auth = useAuthStore()
const frame = computed<FrameCopy>(() => copyFor(auth.state))

function copyFor(state: AuthState): FrameCopy {
  switch (state.type) {
    case 'authenticated':
      return {
        description: 'Access accepted. Opening the active surface.',
        eyebrow: 'NOX // ACCESS CONTROL',
        status: 'Authorized',
        statusTone: 'operational',
        title: `Welcome, ${state.account.username}`,
      }
    case 'checking':
      return {
        description: 'Contacting the local runtime and reading its actual registration state.',
        eyebrow: 'NOX // LINK INITIALIZATION',
        status: 'Connecting',
        statusTone: 'waiting',
        title: 'Establishing node link',
      }
    case 'registration-required':
      return {
        description: 'Create the single operator identity that will own this installation.',
        eyebrow: 'NOX // FIRST CLAIM',
        status: 'Unclaimed node',
        statusTone: 'waiting',
        title: 'Claim this machine',
      }
    case 'signed-out':
      return {
        description: 'Identify yourself to enter this local Nox installation.',
        eyebrow: 'NOX // ACCESS CONTROL',
        status: 'Node online',
        statusTone: 'operational',
        title: 'Return to Nox',
      }
    case 'unavailable':
      return {
        description: 'The web surface is running, but the Nox runtime did not answer.',
        eyebrow: 'NOX // CONNECTION FAULT',
        status: 'Node unavailable',
        statusTone: 'danger',
        title: 'Waiting for Nox node',
      }
  }
}
</script>

<template>
  <AccessFrame
    :description="frame.description"
    :eyebrow="frame.eyebrow"
    :status="frame.status"
    :status-tone="frame.statusTone"
    :title="frame.title"
  >
    <div v-if="auth.state.type === 'checking'" class="pending" aria-live="polite">
      <span class="pending__cursor" aria-hidden="true"></span>
      <p>Reading <code>/api/auth/status</code></p>
    </div>

    <RegistrationForm v-else-if="auth.state.type === 'registration-required'" />

    <LoginForm v-else-if="auth.state.type === 'signed-out'" />

    <div v-else-if="auth.state.type === 'unavailable'" class="recovery">
      <NoxNotice title="Runtime did not answer" tone="danger">
        <p>Check that the container is running and that its HTTP surface is reachable.</p>
      </NoxNotice>
      <NoxButton block variant="secondary" @click="auth.initialize()">Retry connection</NoxButton>
    </div>
  </AccessFrame>
</template>

<style scoped lang="scss">
.pending,
.recovery {
  display: grid;
  gap: var(--nox-space-4);
}

.pending {
  grid-template-columns: auto 1fr;
  align-items: center;
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-sm);
}

.pending p {
  margin: 0;
}

.pending code {
  color: var(--nox-text-secondary);
}

.pending__cursor {
  width: 0.65rem;
  height: 1rem;
  background: var(--nox-action-primary);
  box-shadow: var(--nox-glow-operational);
  animation: blink 1s steps(2, jump-none) infinite;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .pending__cursor {
    animation: none;
  }
}
</style>
