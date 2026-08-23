import { z } from 'zod'

import type { MessageParameters } from '@/shared/i18n'

type Translate = (key: string, parameters?: MessageParameters) => string

interface LoginForm {
  readonly password: string
  readonly username: string
}

interface RegistrationForm extends LoginForm {
  readonly code: string
  readonly confirmPassword: string
}

function credentialsSchema(t: Translate) {
  return z.object({
    password: z
      .string()
      .min(8, t('auth.validation.passwordMin'))
      .max(200, t('auth.validation.passwordMax')),
    username: z
      .string()
      .trim()
      .min(3, t('auth.validation.identityMin'))
      .max(64, t('auth.validation.identityMax'))
      .regex(/^[A-Za-z0-9._-]+$/, t('auth.validation.identityCharacters')),
  })
}

function loginFormSchema(t: Translate): z.ZodType<LoginForm> {
  return credentialsSchema(t)
}

function registrationFormSchema(t: Translate): z.ZodType<RegistrationForm> {
  return credentialsSchema(t)
    .extend({
      code: z.string().trim().min(1, t('auth.validation.claimCodeRequired')),
      confirmPassword: z.string().min(1, t('auth.validation.confirmPasswordRequired')),
    })
    .refine((value) => value.password === value.confirmPassword, {
      message: t('auth.validation.passwordsMismatch'),
      path: ['confirmPassword'],
    })
}

export { loginFormSchema, registrationFormSchema }

export type { LoginForm, RegistrationForm }
