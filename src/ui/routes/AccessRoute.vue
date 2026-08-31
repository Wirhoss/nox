<script setup lang="ts">
import { computed } from 'vue'

import { useAuthStore } from '@/app/stores/auth.store'
import AccessFrame from '@/features/auth/components/AccessFrame.vue'
import LoginForm from '@/features/auth/components/LoginForm.vue'
import RegistrationForm from '@/features/auth/components/RegistrationForm.vue'
import { useI18n } from '@/shared/i18n'
import { NoxButton } from '@/shared/ui/NoxButton'
import { NoxNotice } from '@/shared/ui/NoxNotice'

import type { AuthState } from '@/app/stores/auth.store'

interface FrameCopy {
  readonly description: string
  readonly eyebrow: string
  readonly status: string
  readonly statusTone: 'danger' | 'operational' | 'waiting'
  readonly title: string
}

const auth = useAuthStore()
const { t } = useI18n()
const frame = computed<FrameCopy>(() => copyFor(auth.state))

function copyFor(state: AuthState): FrameCopy {
  switch (state.type) {
    case 'authenticated':
      return {
        description: t('access.authenticated.description'),
        eyebrow: t('access.authenticated.eyebrow'),
        status: t('access.authenticated.status'),
        statusTone: 'operational',
        title: t('access.authenticated.title', { username: state.account.username }),
      }
    case 'checking':
      return {
        description: t('access.checking.description'),
        eyebrow: t('access.checking.eyebrow'),
        status: t('access.checking.status'),
        statusTone: 'waiting',
        title: t('access.checking.title'),
      }
    case 'registration-required':
      return {
        description: t('access.registration.description'),
        eyebrow: t('access.registration.eyebrow'),
        status: t('access.registration.status'),
        statusTone: 'waiting',
        title: t('access.registration.title'),
      }
    case 'signed-out':
      return {
        description: t('access.signedOut.description'),
        eyebrow: t('access.signedOut.eyebrow'),
        status: t('access.signedOut.status'),
        statusTone: 'operational',
        title: t('access.signedOut.title'),
      }
    case 'unavailable':
      return {
        description: t('access.unavailable.description'),
        eyebrow: t('access.unavailable.eyebrow'),
        status: t('access.unavailable.status'),
        statusTone: 'danger',
        title: t('access.unavailable.title'),
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
      <p>{{ t('access.checking.reading') }} <code>/api/auth/status</code></p>
    </div>

    <RegistrationForm v-else-if="auth.state.type === 'registration-required'" />

    <LoginForm v-else-if="auth.state.type === 'signed-out'" />

    <div v-else-if="auth.state.type === 'unavailable'" class="recovery">
      <NoxNotice :title="t('access.unavailable.noticeTitle')" tone="danger">
        <p>{{ t('access.unavailable.noticeBody') }}</p>
      </NoxNotice>
      <NoxButton block variant="secondary" @click="auth.initialize()">{{
        t('common.retryConnection')
      }}</NoxButton>
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
