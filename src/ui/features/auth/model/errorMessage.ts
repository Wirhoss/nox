import { AuthActionError } from '@/app/stores/auth.store'

function authErrorMessage(error: unknown): string {
  if (!(error instanceof AuthActionError)) {
    return 'Nox rejected the request unexpectedly. Try again.'
  }

  switch (error.code) {
    case 'already-registered':
      return 'This Nox was claimed by another request. Sign in with the registered identity.'
    case 'invalid-code':
      return 'The claim code is invalid or expired. Check the current Nox container logs.'
    case 'invalid-credentials':
      return 'Identity or password is incorrect.'
    case 'unavailable':
      return 'The Nox node stopped responding. Check the runtime and try again.'
    case 'unexpected':
      return 'Nox returned an unexpected response. Try again or open diagnostics.'
  }
}

export { authErrorMessage }
