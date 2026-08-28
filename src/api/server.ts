import { type AnyElysia, Elysia } from 'elysia';

import { type Logger, silentLogger } from '../logger/logger';
import { parseOrThrow } from '../utils/validate';
import { artifactRoutes } from './artifacts/routes';
import { authRoutes } from './auth/routes';
import { chatRoutes } from './chat/routes';
import { configRoutes } from './config/routes';
import { extensionRoutes } from './extensions/routes';
import { health, type ReadinessChecks } from './health';
import { languageRoutes } from './i18n/routes';
import { API_PREFIX } from './prefix';
import { secretRoutes } from './secrets/routes';
import { type ApiConfig, type ApiConfigInput, apiConfigSchema } from './serverConfig';
import { type SessionReader, sessionRoutes } from './sessions/routes';
import { ui } from './ui';

import type { ArtifactPipeline } from '../artifact/pipeline';
import type { SecretStore } from '../config/secrets';
import type { ExtensionCatalog } from '../extensions/catalog';
import type { RegistrationWindow } from './auth/registration';
import type { AuthStore } from './auth/store';
import type { ChatHub } from './chat/transport';
import type { ConfigStore } from './config/store';
import type { ContributionReader, Disposable } from '@nox/extension-api';

/** The two halves of authentication a composed Nox hands in: who exists, and who may still claim it. */
interface ApiAuth {
  registration: RegistrationWindow;
  store: AuthStore;
}

interface ApiServerOptions extends ApiConfigInput {
  /** Mounts durable artifact upload and content routes; requires `auth`. */
  artifacts?: ArtifactPipeline;
  /**
   * Mounts `/api/auth` and lets routes demand a token. Left out, nothing is
   * protected and nothing can be — which is what the health-probe tests want
   * and what a real Nox never does.
   */
  auth?: ApiAuth;
  /**
   * Mounts `/api/chat`, where the browser talks to whatever broker claims the
   * surface. It needs `auth`: a conversation route that cannot name who is
   * speaking has no sender to vouch for, and an unauthenticated one would be
   * anyone at all.
   */
  chat?: ChatHub;
  /** The dependencies `/api/health/ready` reports on. Empty means always ready. */
  checks?: ReadinessChecks;
  /**
   * Mounts `/api/config`, where configuration is administered: the blueprints
   * that are the whole of what each agent will do, the providers Nox talks
   * through, the tool sets that exist at all, and the `app.json` holding the
   * token lifetimes protecting this surface. It needs `auth` for every one of
   * those reasons.
   */
  config?: ConfigStore;
  /** Registry used to attribute contribution inventory to discovered packages. */
  contributions?: ContributionReader;
  /** Discovered package health and contribution inventory. Requires `auth`. */
  extensions?: ExtensionCatalog;
  /** Installation language preference exposed publicly with the language catalog. */
  locale?: (() => string | undefined) | string;
  /** Language packs and extension-owned translation fragments exposed to the UI. */
  languages?: ContributionReader;
  logger?: Logger;
  /**
   * Mounts `/api/secrets`, where the credentials behind every outbound call are
   * written. Values only ever go in; the routes have no way to read one back,
   * and `auth` is what stands between the write and anybody at all.
   */
  secrets?: SecretStore;
  /** Historical conversations, transcripts and per-session audit projections. */
  sessions?: SessionReader;
  /** Vite build directory to expose at `/`; omitted when no web UI is available. */
  uiDirectory?: string;
  version?: string;
}

/**
 * The HTTP surface. Like the terminal in `cli.ts` it is a way in, not part of
 * the application: it holds nothing, and every answer it gives comes from
 * something handed to it.
 *
 * Building it and opening the port are separate acts, because they belong to
 * different moments. The surface is assembled while Nox is still configurable,
 * which is when whoever composes it can hand it over to be released on
 * shutdown; the socket opens last, once the runtime behind it is whole. A port
 * that is answering is a promise that there is something to answer with.
 *
 * It is a `Disposable`, so whoever composes it can hand it to the application
 * and let the shutdown that closes everything else close this too.
 */
class ApiServer implements Disposable {
  readonly #app: AnyElysia;
  readonly #config: ApiConfig;
  readonly #logger: Logger;

  #listening = false;
  #stopped = false;

  private constructor(app: AnyElysia, config: ApiConfig, logger: Logger) {
    this.#app = app;
    this.#config = config;
    this.#logger = logger;
  }

  /** Assembles the surface. Nothing is listening when this returns. */
  public static create(options: ApiServerOptions = {}): ApiServer {
    const config = parseOrThrow(apiConfigSchema, {
      host: options.host,
      port: options.port,
    });
    const logger = options.logger ?? silentLogger;

    const api = new Elysia({ name: 'nox.api', prefix: API_PREFIX })
      .onError({ as: 'global' }, ({ code, error, request }) => {
        if (code !== 'UNKNOWN' && code !== 'INTERNAL_SERVER_ERROR') return;
        logger.error(
          {
            code,
            err: error,
            method: request.method,
            path: new URL(request.url).pathname,
            stack: error.stack,
          },
          'Unhandled API request error.',
        );
      })
      .use(health({ checks: options.checks, version: options.version }));
    if (options.languages !== undefined) {
      api.use(
        languageRoutes({ configuredLocale: options.locale, contributions: options.languages }),
      );
    }
    if (options.auth !== undefined) {
      api.use(authRoutes(options.auth));
      if (options.sessions !== undefined) {
        api.use(sessionRoutes({ sessions: options.sessions, store: options.auth.store }));
      }
      if (options.artifacts !== undefined) {
        api.use(artifactRoutes({ artifacts: options.artifacts, store: options.auth.store }));
      }
      if (options.config !== undefined) {
        api.use(configRoutes({ config: options.config, store: options.auth.store }));
      }
      if (options.extensions !== undefined && options.contributions !== undefined) {
        api.use(
          extensionRoutes({
            catalog: options.extensions,
            contributions: options.contributions,
            store: options.auth.store,
          }),
        );
      }
      if (options.secrets !== undefined) {
        api.use(secretRoutes({ secrets: options.secrets, store: options.auth.store }));
      }
      if (options.chat !== undefined) {
        api.use(
          chatRoutes({
            artifacts: options.artifacts,
            hub: options.chat,
            store: options.auth.store,
          }),
        );
      }
    }

    const app = new Elysia().use(api);
    if (options.uiDirectory !== undefined) {
      app.use(ui({ apiPrefix: API_PREFIX, directory: options.uiDirectory }));
    }

    return new ApiServer(app, config, logger);
  }

  /** The address it actually bound to: port 0 in the config resolves here. */
  public get url(): string {
    const port = this.#app.server?.port ?? this.#config.port;
    return `http://${this.#config.host}:${String(port)}`;
  }

  /** Resolves once the socket is accepting connections, never before. */
  public async listen(): Promise<void> {
    if (this.#stopped) throw new Error('The API server has already stopped.');
    if (this.#listening) return;

    await new Promise<void>((resolve) => {
      this.#app.listen({ hostname: this.#config.host, port: this.#config.port }, () => {
        resolve();
      });
    });
    this.#listening = true;

    this.#logger.info({ url: this.url }, 'API is listening.');
  }

  public async dispose(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (!this.#listening) return;

    await this.#app.stop();
    this.#logger.info({}, 'API has stopped listening.');
  }
}

export { ApiServer };

export type { ApiAuth, ApiServerOptions };
