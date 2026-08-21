<script setup lang="ts">
import { toTypedSchema } from '@vee-validate/zod'
import { useForm } from 'vee-validate'
import { ref } from 'vue'

import { useAuthStore } from '@/app/stores/auth.store'
import { NoxButton } from '@/shared/ui/NoxButton'
import { NoxNotice } from '@/shared/ui/NoxNotice'
import { NoxTextField } from '@/shared/ui/NoxTextField'

import { authErrorMessage } from '../model/errorMessage'
import { type LoginForm, loginFormSchema } from '../model/forms'

const auth = useAuthStore()
const serverError = ref<string>()

const { defineField, errors, handleSubmit, isSubmitting } = useForm<LoginForm>({
  initialValues: { password: '', username: '' },
  validationSchema: toTypedSchema(loginFormSchema),
})

const [username, usernameBindings] = defineField('username')
const [password, passwordBindings] = defineField('password')

const submit = handleSubmit(async (values) => {
  serverError.value = undefined
  try {
    await auth.login(values)
  } catch (error) {
    serverError.value = authErrorMessage(error)
  }
})
</script>

<template>
  <form class="form" novalidate @submit="submit">
    <NoxNotice
      v-if="auth.state.type === 'signed-out' && auth.state.notice === 'registration-closed'"
      title="Registration closed"
      tone="warning"
    >
      <p>This Nox has just been claimed. Sign in with the registered identity.</p>
    </NoxNotice>

    <NoxNotice v-if="serverError !== undefined" title="Access denied" tone="danger">
      <p>{{ serverError }}</p>
    </NoxNotice>

    <NoxTextField
      id="login-identity"
      v-model="username"
      v-bind="usernameBindings"
      name="username"
      label="Identity"
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
      label="Password"
      type="password"
      autocomplete="current-password"
      placeholder="Enter your password"
      :error="errors.password"
      required
    />

    <NoxButton block :busy="isSubmitting" type="submit">Enter Nox</NoxButton>
  </form>
</template>

<style scoped lang="scss">
.form {
  display: grid;
  gap: var(--nox-space-5);
}
</style>
