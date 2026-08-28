/** UI-only option value used to open a new write-only credential input. */
const NEW_SECRET = '__new_secret__'

interface CredentialState {
  newId: string
  selection: string
  value: string
}

export { NEW_SECRET }

export type { CredentialState }
