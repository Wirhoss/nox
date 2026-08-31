<script setup lang="ts">
import { useI18n } from '@/shared/i18n'
import LanguageSelector from '@/shared/i18n/LanguageSelector.vue'
import { NoxMark } from '@/shared/ui/NoxMark'
import { NoxPanel } from '@/shared/ui/NoxPanel'
import { NoxStatus } from '@/shared/ui/NoxStatus'

type StatusTone = 'danger' | 'operational' | 'waiting'

interface Props {
  description: string
  eyebrow: string
  status: string
  statusTone?: StatusTone
  title: string
}

const props = withDefaults(defineProps<Props>(), {
  statusTone: 'operational',
})
const { t } = useI18n()
</script>

<template>
  <main class="access">
    <div class="access__rail" aria-hidden="true">
      <span>{{ t('access.frame.localNode') }}</span>
      <span>00 / NOX</span>
    </div>

    <div class="access__layout">
      <aside class="access__identity">
        <NoxMark />

        <div class="access__statement">
          <p class="access__overline">{{ t('access.frame.personalRuntime') }}</p>
          <p class="access__manifesto">{{ t('access.frame.manifesto') }}</p>
        </div>
      </aside>

      <NoxPanel class="access__panel" labelled-by="access-title">
        <header class="access__header">
          <p class="access__eyebrow">{{ props.eyebrow }}</p>
          <NoxStatus :label="props.status" :tone="props.statusTone" />
        </header>

        <div class="access__content">
          <div class="access__intro">
            <h1 id="access-title">{{ props.title }}</h1>
            <p>{{ props.description }}</p>
          </div>

          <slot />
        </div>

        <footer class="access__footer">
          <span>{{ t('access.frame.ownerOperated') }}</span>
          <LanguageSelector />
          <span>{{ t('access.frame.accessSurface') }}</span>
        </footer>
      </NoxPanel>
    </div>
  </main>
</template>

<style scoped lang="scss">
.access {
  display: grid;
  min-height: 100vh;
  grid-template-columns: 3rem 1fr;
}

.access__rail {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--nox-space-6) 0;
  border-inline-end: 1px solid var(--nox-border-subtle);
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: 0.6rem;
  letter-spacing: var(--nox-tracking-system);
  writing-mode: vertical-rl;
}

.access__layout {
  display: grid;
  width: min(100%, var(--nox-content-wide));
  min-height: 100vh;
  margin: 0 auto;
  grid-template-columns: minmax(16rem, 0.8fr) minmax(24rem, 1fr);
  align-items: center;
  gap: clamp(var(--nox-space-8), 7vw, var(--nox-space-16));
  padding: var(--nox-space-8);
}

.access__identity {
  display: flex;
  min-height: 32rem;
  flex-direction: column;
  justify-content: center;
  gap: clamp(var(--nox-space-8), 8vh, var(--nox-space-16));
  padding: var(--nox-space-4) 0;
}

.access__overline,
.access__eyebrow {
  margin: 0;
  color: var(--nox-action-primary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  font-weight: 700;
  letter-spacing: var(--nox-tracking-system);
  text-transform: uppercase;
}

.access__manifesto {
  margin: var(--nox-space-4) 0 0;
  color: var(--nox-text-primary);
  font-family: var(--nox-font-interface);
  font-size: clamp(1.75rem, 4vw, 3.5rem);
  font-weight: 650;
  letter-spacing: -0.04em;
  line-height: 1.04;
  white-space: pre-line;
}

.access__panel {
  width: 100%;
  max-width: var(--nox-content-narrow);
  justify-self: end;
}

.access__header,
.access__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-4);
  padding: var(--nox-space-4) var(--nox-space-5);
  background: var(--nox-canvas-raised);
}

.access__header {
  border-bottom: 1px solid var(--nox-border-subtle);
}

.access__content {
  display: grid;
  gap: var(--nox-space-8);
  padding: clamp(var(--nox-space-6), 5vw, var(--nox-space-10));
}

.access__intro h1 {
  margin: 0;
  font-family: var(--nox-font-interface);
  font-size: var(--nox-text-xl);
  letter-spacing: -0.035em;
  line-height: var(--nox-leading-tight);
}

.access__intro p {
  max-width: 36ch;
  margin: var(--nox-space-3) 0 0;
  color: var(--nox-text-secondary);
  font-size: var(--nox-text-sm);
}

.access__footer {
  border-top: 1px solid var(--nox-border-subtle);
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: 0.6rem;
  letter-spacing: 0.1em;
}

@media (max-width: 56rem) {
  .access__layout {
    grid-template-columns: 1fr;
    align-content: center;
  }

  .access__identity {
    min-height: auto;
    gap: var(--nox-space-8);
  }

  .access__statement {
    display: none;
  }

  .access__panel {
    max-width: none;
    justify-self: stretch;
  }
}

@media (max-width: 36rem) {
  .access {
    grid-template-columns: 1fr;
  }

  .access__rail {
    display: none;
  }

  .access__layout {
    padding: var(--nox-space-4);
  }

  .access__identity {
    padding: 0;
  }

  .access__header,
  .access__footer {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
