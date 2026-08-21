import { type AnyElysia, Elysia } from 'elysia';

import { type Logger, silentLogger } from '../logger/logger';
import { parseOrThrow } from '../utils/validate';
import { authRoutes } from './auth/routes';
import { type ApiConfig, type ApiConfigInput, apiConfigSchema } from './config';
import { health, type ReadinessChecks } from './health';

import type { Disposable } from '../extensions/disposable';
import type { RegistrationWindow } from './auth/registration';
import type { AuthStore } from './auth/store';

/** The two halves of authentication a composed Nox hands in: who exists, and who may still claim it. */
interface ApiAuth {
  registration: RegistrationWindow;
  store: AuthStore;
}

interface ApiServerOptions extends ApiConfigInput {
  /**
   * Mounts `/auth` and lets routes demand a token. Left out, nothing is
   * protected and nothing can be — which is what the health-probe tests want
   * and what a real Nox never does.
   */
  auth?: ApiAuth;
  /** The dependencies `/health/ready` reports on. Empty means always ready. */
  checks?: ReadinessChecks;
  logger?: Logger;
  version?: string;
}

/**
 * The HTTP surface. Like the terminal in `cli.ts` it is a way in, not part of
 * the application: it holds nothing, and every answer it gives comes from
 * something handed to it. For now that is the two health probes an orchestrator
 * needs before it will route traffic here.
 *
 * It is a `Disposable`, so whoever composes it can hand it to the application
 * and let the shutdown that closes everything else close this too.
 */
class ApiServer implements Disposable {
  readonly #app: AnyElysia;
  readonly #config: ApiConfig;
  readonly #logger: Logger;

  #stopped = false;

  private constructor(app: AnyElysia, config: ApiConfig, logger: Logger) {
    this.#app = app;
    this.#config = config;
    this.#logger = logger;
  }

  /** Resolves once the socket is accepting connections, never before. */
  public static async start(options: ApiServerOptions = {}): Promise<ApiServer> {
    const config = parseOrThrow(apiConfigSchema, {
      host: options.host,
      port: options.port,
    });
    const logger = options.logger ?? silentLogger;

    const app = new Elysia().use(health({ checks: options.checks, version: options.version }));
    if (options.auth !== undefined) app.use(authRoutes(options.auth));

    await new Promise<void>((resolve) => {
      app.listen({ hostname: config.host, port: config.port }, () => {
        resolve();
      });
    });

    const server = new ApiServer(app, config, logger);
    logger.info({ url: server.url }, 'API is listening.');
    return server;
  }

  /** The address it actually bound to: port 0 in the config resolves here. */
  public get url(): string {
    const port = this.#app.server?.port ?? this.#config.port;
    return `http://${this.#config.host}:${String(port)}`;
  }

  public async dispose(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    await this.#app.stop();
    this.#logger.info({}, 'API has stopped listening.');
  }
}

export { ApiServer };

export type { ApiAuth, ApiServerOptions };
