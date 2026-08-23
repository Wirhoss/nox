<script setup lang="ts">
import { useI18n } from './i18n'

const { availableLanguages, locale, setLocale, t } = useI18n()
</script>

<template>
  <label v-if="availableLanguages.length > 1" class="language-selector">
    <span>{{ t('common.language') }}</span>
    <select :value="locale" @change="setLocale(($event.target as HTMLSelectElement).value)">
      <option
        v-for="language in availableLanguages"
        :key="language.locale"
        :value="language.locale"
      >
        {{ language.name }}
      </option>
    </select>
  </label>
</template>

<style scoped lang="scss">
.language-selector {
  display: grid;
  gap: var(--nox-space-1);
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.language-selector select {
  min-width: 0;
  padding: var(--nox-space-2);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-secondary);
  background: var(--nox-surface-input);
  font: inherit;
}
</style>
