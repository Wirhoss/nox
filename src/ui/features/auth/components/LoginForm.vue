<script setup lang="ts">
import { toTypedSchema } from '@vee-validate/zod'
import { useForm } from 'vee-validate'
import { computed, ref } from 'vue'

import { useAuthStore } from '@/app/stores/auth.store'
import { useI18n } from '@/shared/i18n'
import { NoxButton } from '@/shared/ui/NoxButton'
import { NoxNotice } from '@/shared/ui/NoxNotice'
import { NoxTextField } from '@/shared/ui/NoxTextField'

import { authErrorMessage } from '../model/errorMessage'
import { type LoginForm, loginFormSchema } from '../model/forms'

const auth = useAuthStore()
const { locale, t } = useI18n()
const serverError = ref<string>()

const validationSchema = computed(() => {
  void locale.value
  return toTypedSchema(loginFormSchema(t))
})
const { defineField, errors, handleSubmit, isSubmitting } = useForm<LoginForm>({
  initialValues: { password: '', username: '' },
  validationSchema,
})

const [username, usernameBindings] = defineField('username')
const [password, passwordBindings] = defineField('password')

const submit = handleSubmit(async (values) => {
  serverError.value = undefined
  try {
    await auth.login(values)
  } catch (error) {
    serverError.value = authErrorMessage(error, t)
  }
})
</script>

<template>
  <form class="form" novalidate @submit="submit">
    <NoxNotice
      v-if="auth.state.type === 'signed-out' && auth.state.notice === 'registration-closed'"
      :title="t('auth.login.registrationClosedTitle')"
      tone="warning"
    >
      <p>{{ t('auth.login.registrationClosedBody') }}</p>
    </NoxNotice>

    <NoxNotice v-if="serverError !== undefined" :title="t('auth.login.accessDenied')" tone="danger">
      <p>{{ serverError }}</p>
    </NoxNotice>

    <NoxTextField
      id="login-identity"
      v-model="username"
      v-bind="usernameBindings"
      name="username"
      :label="t('auth.field.identity')"
      autocomplete="username"
      placeholder="operator"
      :error="errors.username"
      required
    />

    <NoxTextField
      id="login-password"
      v-model="password"
      v-bind="passwordBindings"
      name="password"
      :label="t('auth.field.password')"
      type="password"
      autocomplete="current-password"
      :placeholder="t('auth.login.passwordPlaceholder')"
      :error="errors.password"
      required
    />

    <NoxButton block :busy="isSubmitting" type="submit">{{ t('auth.login.submit') }}</NoxButton>
  </form>
</template>

<style scoped lang="scss">
.form {
  display: grid;
  gap: var(--nox-space-5);
}
</style>
