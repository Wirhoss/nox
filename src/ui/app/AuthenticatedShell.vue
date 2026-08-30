<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'

import { useAuthStore } from '@/app/stores/auth.store'
import { authErrorMessage } from '@/features/auth/model/errorMessage'
import { useI18n } from '@/shared/i18n'
import { NoxButton } from '@/shared/ui/NoxButton'
import { NoxMark } from '@/shared/ui/NoxMark'
import { NoxNotice } from '@/shared/ui/NoxNotice'

const auth = useAuthStore()
const { t } = useI18n()
const route = useRoute()
const account = computed(() =>
  auth.state.type === 'authenticated' ? auth.state.account : undefined,
)
const logoutError = ref<string>()
const loggingOut = ref(false)
const sessionsActive = computed(() => route.path.startsWith('/sessions'))
const memoryActive = computed(() => route.path.startsWith('/memory'))
const settingsActive = computed(() => route.path.startsWith('/settings'))

async function logout(): Promise<void> {
  logoutError.value = undefined
  loggingOut.value = true
  try {
    await auth.logout()
  } catch (error) {
    logoutError.value = authErrorMessage(error, t)
  } finally {
    loggingOut.value = false
  }
}
</script>

<template>
  <main v-if="account !== undefined" class="shell">
    <aside class="sidebar">
      <NoxMark />

      <nav class="sidebar__nav" :aria-label="t('navigation.primary')">
        <RouterLink
          class="sidebar__item"
          exact-active-class="sidebar__item--active"
          :to="{ name: 'chat' }"
        >
          <span>01</span> {{ t('navigation.chat') }}
        </RouterLink>
        <RouterLink
          class="sidebar__item"
          :class="{ 'sidebar__item--active': sessionsActive }"
          :aria-current="sessionsActive ? 'page' : undefined"
          :to="{ name: 'sessions' }"
        >
          <span>02</span> {{ t('navigation.sessions') }}
        </RouterLink>
        <RouterLink
          class="sidebar__item"
          :class="{ 'sidebar__item--active': memoryActive }"
          :aria-current="memoryActive ? 'page' : undefined"
          :to="{ name: 'memory' }"
        >
          <span>03</span> {{ t('navigation.memory') }}
        </RouterLink>
        <RouterLink
          class="sidebar__item"
          :class="{ 'sidebar__item--active': settingsActive }"
          :aria-current="settingsActive ? 'page' : undefined"
          :to="{ name: 'settings', params: { section: 'general' } }"
        >
          <span>04</span> {{ t('navigation.settings') }}
        </RouterLink>
      </nav>

      <footer class="sidebar__footer">
        <div>
          <span>{{ t('navigation.identity') }}</span>
          <strong>{{ account.username }}</strong>
        </div>
        <NoxButton :busy="loggingOut" variant="ghost" @click="logout()">{{
          t('navigation.disconnect')
        }}</NoxButton>
      </footer>
    </aside>

    <section class="shell__surface">
      <RouterView />
    </section>

    <NoxNotice
      v-if="logoutError !== undefined"
      class="shell__logout-error"
      :title="t('navigation.logoutFailed')"
    >
      <p>{{ logoutError }}</p>
    </NoxNotice>
  </main>
</template>

<style scoped lang="scss">
.shell {
  display: grid;
  height: 100vh;
  grid-template-columns: 13.5rem minmax(0, 1fr);
  background: var(--nox-canvas);
  overflow: hidden;
}

.sidebar {
  display: flex;
  min-height: 0;
  flex-direction: column;
  padding: var(--nox-space-6);
  border-inline-end: 1px solid var(--nox-border-subtle);
  background: var(--nox-canvas-raised);
}

.sidebar :deep(.mark) {
  align-self: center;
}

.sidebar__nav {
  display: grid;
  gap: var(--nox-space-2);
  margin-top: var(--nox-space-16);
}

.sidebar__item {
  display: flex;
  align-items: center;
  gap: var(--nox-space-3);
  padding: var(--nox-space-3);
  border-inline-start: 2px solid transparent;
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-sm);
  text-decoration: none;
}

.sidebar__item span {
  font-size: 0.62rem;
}

.sidebar__item--active {
  border-inline-start-color: var(--nox-action-primary);
  color: var(--nox-text-primary);
  background: var(--nox-surface-1);
}

.sidebar__item[aria-disabled='true'] {
  cursor: not-allowed;
  opacity: 0.56;
}

.sidebar__footer {
  display: grid;
  gap: var(--nox-space-3);
  margin-top: auto;
  padding-top: var(--nox-space-4);
  border-top: 1px solid var(--nox-border-subtle);
}

.sidebar__footer > div {
  display: grid;
}

.sidebar__footer span {
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: 0.08em;
}

.sidebar__footer strong {
  color: var(--nox-text-secondary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-sm);
  font-weight: 500;
  overflow-wrap: anywhere;
}

.shell__surface {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.shell__logout-error {
  position: fixed;
  z-index: var(--nox-layer-toast);
  inset-inline-end: var(--nox-space-5);
  bottom: var(--nox-space-5);
  width: min(24rem, calc(100% - var(--nox-space-8)));
}

@media (max-width: 75rem) {
  .shell {
    grid-template-columns: 4.25rem minmax(0, 1fr);
  }

  .sidebar {
    align-items: center;
    padding: var(--nox-space-4) var(--nox-space-2);
  }

  .sidebar :deep(.mark) {
    width: 3rem;
  }

  .sidebar__item,
  .sidebar__footer > div {
    font-size: 0;
  }

  .sidebar__item span {
    font-size: var(--nox-text-xs);
  }
}

@media (max-width: 36rem) {
  .shell {
    grid-template-columns: 1fr;
  }

  .sidebar {
    display: none;
  }
}
</style>
