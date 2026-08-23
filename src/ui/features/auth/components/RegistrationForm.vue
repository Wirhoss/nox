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
import { type RegistrationForm, registrationFormSchema } from '../model/forms'

const auth = useAuthStore()
const { locale, t } = useI18n()
const serverError = ref<string>()

const validationSchema = computed(() => {
  void locale.value
  return toTypedSchema(registrationFormSchema(t))
})
const { defineField, errors, handleSubmit, isSubmitting } = useForm<RegistrationForm>({
  initialValues: { code: '', confirmPassword: '', password: '', username: '' },
  validationSchema,
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
    serverError.value = authErrorMessage(error, t)
  }
})
</script>

<template>
  <form class="form" novalidate @submit="submit">
    <NoxNotice
      v-if="serverError !== undefined"
      :title="t('auth.registration.rejected')"
      tone="danger"
    >
      <p>{{ serverError }}</p>
    </NoxNotice>

    <NoxTextField
      id="registration-code"
      v-model="code"
      v-bind="codeBindings"
      class="form__code"
      name="code"
      :label="t('auth.field.claimCode')"
      autocomplete="one-time-code"
      placeholder="NOX-XXXX-XXXX-XXXX"
      :hint="t('auth.registration.claimCodeHint')"
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
      :label="t('auth.field.identity')"
      autocomplete="username"
      placeholder="operator"
      :hint="t('auth.registration.identityHint')"
      :error="errors.username"
      required
    />

    <div class="form__passwords">
      <NoxTextField
        id="registration-password"
        v-model="password"
        v-bind="passwordBindings"
        name="password"
        :label="t('auth.field.password')"
        type="password"
        autocomplete="new-password"
        :placeholder="t('auth.registration.passwordPlaceholder')"
        :error="errors.password"
        required
      />

      <NoxTextField
        id="registration-password-confirmation"
        v-model="confirmPassword"
        v-bind="confirmPasswordBindings"
        name="confirmPassword"
        :label="t('auth.field.confirmPassword')"
        type="password"
        autocomplete="new-password"
        :placeholder="t('auth.registration.confirmPasswordPlaceholder')"
        :error="errors.confirmPassword"
        required
      />
    </div>

    <NoxButton block :busy="isSubmitting" type="submit">{{
      t('auth.registration.submit')
    }}</NoxButton>
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
