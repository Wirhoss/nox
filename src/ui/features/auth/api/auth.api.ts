import { z } from 'zod'

import { requestEmpty, requestJson } from '@/shared/api/http'

const accountSchema = z.object({
  accountId: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  username: z.string().min(1),
})

const authStatusSchema = z.object({ registered: z.boolean() })

const tokenSchema = z.object({
  accessToken: z.string().min(1),
  expiresInSeconds: z.number().int().positive(),
})

const sessionSchema = tokenSchema.extend({ account: accountSchema })
const accountResponseSchema = z.object({ account: accountSchema })

interface Credentials {
  readonly password: string
  readonly username: string
}

interface Registration extends Credentials {
  readonly code: string
}

type Account = z.infer<typeof accountSchema>
type AuthStatus = z.infer<typeof authStatusSchema>
type Session = z.infer<typeof sessionSchema>
type Token = z.infer<typeof tokenSchema>

interface AuthApi {
  login(credentials: Credentials): Promise<Session>
  logout(): Promise<void>
  me(accessToken: string): Promise<Account>
  refresh(): Promise<Token>
  register(registration: Registration): Promise<Session>
  status(): Promise<AuthStatus>
}

function jsonBody(value: unknown): Pick<RequestInit, 'body' | 'method'> {
  return { body: JSON.stringify(value), method: 'POST' }
}

const authApi: AuthApi = {
  login(credentials) {
    return requestJson('/auth/login', sessionSchema, jsonBody(credentials))
  },
  logout() {
    return requestEmpty('/auth/logout', jsonBody({}))
  },
  async me(accessToken) {
    const response = await requestJson('/auth/me', accountResponseSchema, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    return response.account
  },
  refresh() {
    return requestJson('/auth/refresh', tokenSchema, jsonBody({}))
  },
  register(registration) {
    return requestJson('/auth/register', sessionSchema, jsonBody(registration))
  },
  status() {
    return requestJson('/auth/status', authStatusSchema)
  },
}

export { authApi }

export type { Account, AuthApi, AuthStatus, Credentials, Registration, Session, Token }
