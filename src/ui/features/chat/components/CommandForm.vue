<script setup lang="ts">
import { ref, watch } from 'vue'

import { useI18n } from '@/shared/i18n'
import { NoxButton } from '@/shared/ui/NoxButton'

import { fieldsOf, type JsonObject, seedArguments } from '../model/commandForm'
import CommandSchemaFields from './CommandSchemaFields.vue'

import type { ChatCommand } from '../api/chat.schemas'

interface Props {
  busy?: boolean
  command: ChatCommand
}

const props = defineProps<Props>()
const emit = defineEmits<{
  cancel: []
  submit: [argumentsValue: Readonly<JsonObject>]
}>()
const { t } = useI18n()
const argumentsValue = ref<JsonObject>(seedArguments(props.command.parameters))

watch(
  () => props.command,
  (command) => {
    argumentsValue.value = seedArguments(command.parameters)
  },
)

function submit(): void {
  emit('submit', argumentsValue.value)
}
</script>

<template>
  <form class="command-form" @submit.prevent="submit">
    <header>
      <div>
        <strong>/{{ props.command.name }}</strong>
        <p>{{ props.command.description }}</p>
      </div>
      <button type="button" class="command-form__back" @click="emit('cancel')">
        {{ t('common.cancel') }}
      </button>
    </header>

    <CommandSchemaFields
      v-if="fieldsOf(props.command.parameters).length > 0"
      :id-prefix="`command-${props.command.name}`"
      :schema="props.command.parameters"
      :value="argumentsValue"
      @update="argumentsValue = $event"
    />
    <p v-else class="command-form__empty">{{ t('chat.command.noArguments') }}</p>

    <NoxButton :busy="props.busy" :disabled="props.busy" type="submit">
      {{ t('chat.composer.runCommand') }}
    </NoxButton>
  </form>
</template>

<style scoped lang="scss">
.command-form {
  display: grid;
  gap: var(--nox-space-4);
}

.command-form header {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: var(--nox-space-4);
}

.command-form header strong {
  color: var(--nox-action-primary);
  font-family: var(--nox-font-mono);
}

.command-form header p,
.command-form__empty {
  margin: var(--nox-space-1) 0 0;
  color: var(--nox-text-muted);
  font-size: var(--nox-text-sm);
}

.command-form__back {
  padding: var(--nox-space-1) var(--nox-space-2);
  border: 0;
  color: var(--nox-text-secondary);
  background: transparent;
  cursor: pointer;
}

.command-form > :last-child {
  justify-self: end;
}
</style>
