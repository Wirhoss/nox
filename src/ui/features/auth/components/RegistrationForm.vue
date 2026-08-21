<script setup lang="ts">
import { toTypedSchema } from '@vee-validate/zod'
import { useForm } from 'vee-validate'
import { ref } from 'vue'

import { useAuthStore } from '@/app/stores/auth.store'
import { NoxButton } from '@/shared/ui/NoxButton'
import { NoxNotice } from '@/shared/ui/NoxNotice'
import { NoxTextField } from '@/shared/ui/NoxTextField'

import { authErrorMessage } from '../model/errorMessage'
import { type RegistrationForm, registrationFormSchema } from '../model/forms'

const auth = useAuthStore()
const serverError = ref<string>()

const { defineField, errors, handleSubmit, isSubmitting } = useForm<RegistrationForm>({
  initialValues: { code: '', confirmPassword: '', password: '', username: '' },
  validationSchema: toTypedSchema(registrationFormSchema),
})

const [code, codeBindings] = defineField('code')
const [username, usernameBindings] = defineField('username')
const [password, passwordBindings] = defineField('password')
const [confirmPassword, confirmPasswordBindings] = defineField('confirmPassword')

const submit = handleSubmit(async (values) => {
  serverError.value = undefined
  try {
    await auth.register({
      code: values.code.toUpperCase(),
      password: values.password,
      username: values.username,
    })
  } catch (error) {
    serverError.value = authErrorMessage(error)
  }
})
</script>

<template>
  <form class="form" novalidate @submit="submit">
    <NoxNotice v-if="serverError !== undefined" title="Claim rejected" tone="danger">
      <p>{{ serverError }}</p>
    </NoxNotice>

    <NoxTextField
      id="registration-code"
      v-model="code"
      v-bind="codeBindings"
      class="form__code"
      name="code"
      label="Claim code"
      autocomplete="one-time-code"
      placeholder="NOX-XXXX-XXXX-XXXX"
      hint="Printed in the current Nox container logs. A restart creates a new code."
      :error="errors.code"
      autocapitalize="characters"
      spellcheck="false"
      required
    />

    <NoxTextField
      id="registration-identity"
      v-model="username"
      v-bind="usernameBindings"
      name="username"
      label="Identity"
      autocomplete="username"
      placeholder="operator"
      hint="Letters, digits, dots, dashes and underscores only."
      :error="errors.username"
      required
    />

    <div class="form__passwords">
      <NoxTextField
        id="registration-password"
        v-model="password"
        v-bind="passwordBindings"
        name="password"
        label="Password"
        type="password"
        autocomplete="new-password"
        placeholder="8 characters minimum"
        :error="errors.password"
        required
      />

      <NoxTextField
        id="registration-password-confirmation"
        v-model="confirmPassword"
        v-bind="confirmPasswordBindings"
        name="confirmPassword"
        label="Confirm password"
        type="password"
        autocomplete="new-password"
        placeholder="Repeat your password"
        :error="errors.confirmPassword"
        required
      />
    </div>

    <NoxButton block :busy="isSubmitting" type="submit">Claim this Nox</NoxButton>
  </form>
</template>

<style scoped lang="scss">
.form {
  display: grid;
  gap: var(--nox-space-5);
}

.form__code {
  font-family: var(--nox-font-mono);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.form__passwords {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--nox-space-4);
}

@media (max-width: 30rem) {
  .form__passwords {
    grid-template-columns: 1fr;
  }
}
</style>
