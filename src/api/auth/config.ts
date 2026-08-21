import { z } from 'zod';

/**
 * Two lifetimes with different jobs. The access token is short because it is
 * checked on every request and travels the most; the refresh token is long
 * because it is what keeps a browser signed in across days, and it is stored
 * where it can be revoked the moment that stops being wanted.
 */
const authConfigSchema = z.object({
  /** How long an access token stays valid. Short: a revoked session is caught by the guard anyway. */
  accessTtlSeconds: z
    .number()
    .int()
    .min(60)
    .max(60 * 60)
    .default(15 * 60),
  /** How long a login survives without use before it has to be repeated. */
  refreshTtlSeconds: z
    .number()
    .int()
    .min(60 * 60)
    .max(365 * 24 * 60 * 60)
    .default(30 * 24 * 60 * 60),
  /**
   * Whether the refresh cookie may only travel over HTTPS. Off by default
   * because the ordinary Nox is reached at `http://localhost:8080` and a cookie
   * the browser refuses to send is a login that silently never persists. Turn it
   * on when Nox sits behind TLS, which is the only case where it can be honoured.
   */
  secureCookies: z.boolean().default(false),
});

type AuthConfig = z.infer<typeof authConfigSchema>;

type AuthConfigInput = z.input<typeof authConfigSchema>;

export { authConfigSchema };

export type { AuthConfig, AuthConfigInput };
