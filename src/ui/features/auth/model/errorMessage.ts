import { AuthActionError } from '@/app/stores/auth.store'

import type { MessageParameters } from '@/shared/i18n'

type Translate = (key: string, parameters?: MessageParameters) => string

function authErrorMessage(error: unknown, t: Translate): string {
  if (!(error instanceof AuthActionError)) return t('auth.error.rejectedUnexpectedly')

  switch (error.code) {
    case 'already-registered':
      return t('auth.error.alreadyRegistered')
    case 'invalid-code':
      return t('auth.error.invalidCode')
    case 'invalid-credentials':
      return t('auth.error.invalidCredentials')
    case 'unavailable':
      return t('auth.error.unavailable')
    case 'unexpected':
      return t('auth.error.unexpectedResponse')
  }
}

export { authErrorMessage }
