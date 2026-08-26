import { watch } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { RegistrationWindow } from './api/auth/registration';
import { AuthStore } from './api/auth/store';
import { ChatHub } from './api/chat/transport';
import { ConfigStore } from './api/config/store';
import { type ApiAuth, ApiServer } from './api/server';
import { NoxApplication } from './application';
import { ArtifactPipeline } from './artifact/pipeline';
import { AuthorityCatalog, type AuthorityDefinition } from './auth/authority';
import { GrantAuthorizationProvider, OwnerAuthorizationProvider } from './auth/authorization';
import { CORE_AUTHORITIES } from './auth/coreAuthorities';
import { Config } from './config/config';
import { type EnvSource, readEnvConfig } from './config/env';
import { composeWithSecrets, SecretStore } from './config/secrets';
import { Database } from './database/database';
import { WEB_BROKER_ID, webBrokerExtension } from './extensions/builtin/brokers/web/extension';
import { englishLanguageExtension } from './extensions/builtin/languages/en/extension';
import { spanishLanguageExtension } from './extensions/builtin/languages/es/extension';
import { sharpImageExtension } from './extensions/builtin/processors/sharp/extension';
import { openAIExtension } from './extensions/builtin/providers/openai/extension';
import { cronJobsExtension } from './extensions/builtin/toolsets/cronjobs/extension';
import { webToolsExtension } from './extensions/builtin/toolsets/web/extension';
import { authorities } from './extensions/contribution-points/authorities';
import { brokers } from './extensions/contribution-points/brokers';
import { toDisposable } from './extensions/disposable';
import { ToolSetCatalog } from './extensions/toolSetCatalog';
import { type BrokerGrant, Gateway } from './gateway/gateway';
import { createLogger, type Logger } from './logger/logger';
import {
  ConfigurationRuntimeController,
  ConfigurationRuntimeRelay,
} from './runtime/configurationRuntime';
import { ScheduledRunRelay } from './scheduler/scheduledRun';
import {
  artifactPipelineService,
  chatHubService,
  configService,
  databaseService,
  loggerService,
  scheduledRunHostService,
  secretStoreService,
} from './services';

import type { AuthConfig } from './api/auth/config';
import type { ApiConfig } from './api/serverConfig';

interface BootstrapOptions {
  env?: EnvSource;
  /** Defaults to a logger at the configured level; tests pass a silent one. */
  logger?: Logger;
}

/**
 * The composition root of the process: the one place allowed to name concrete
 * capabilities. It reads the environment, loads configuration, opens storage,
 * hands all three to the application as services, activates the builtin
 * extensions, builds the providers that were configured from what those
 * extensions contributed, and registers one agent per blueprint on disk.
 * Nothing below it imports a builtin.
 *
 * What comes back is the running Nox itself — the process holds one object, and
 * stopping it stops everything this function opened.
 */
async function bootstrap(options: BootstrapOptions = {}): Promise<NoxApplication> {
  const env = readEnvConfig(options.env ?? process.env);

  // Configuration decides the log level, so loading it needs a logger already.
  const config = await Config.load(env, { logger: options.logger ?? createLogger('nox') });
  const appConfig = config.get('app');
  const logger = options.logger ?? createLogger('nox', { level: appConfig.logLevel });
  const configurationRuntime = new ConfigurationRuntimeRelay();

  await mkdir(env.dataDir, { recursive: true });
  const database = await Database.open({
    ...appConfig.database,
    logger,
    path: isAbsolute(appConfig.database.path)
      ? appConfig.database.path
      : join(env.dataDir, appConfig.database.path),
  });

  let artifactPipeline: ArtifactPipeline;
  let secretStore: SecretStore;
  try {
    artifactPipeline = await ArtifactPipeline.open({
      dataDirectory: env.dataDir,
      database,
      logger: logger.child('artifacts'),
      maxArtifactBytes: appConfig.artifacts.maxArtifactBytes,
      maxStorageBytes: appConfig.artifacts.maxStorageBytes,
    });
    secretStore = await SecretStore.open({
      changed: () => configurationRuntime.reconcile(),
      dataDirectory: env.dataDir,
      database,
      logger: logger.child('secrets'),
      references: () => config.secretReferences(),
    });
  } catch (error) {
    await database.close();
    throw error;
  }

  // The HTTP chat surface owns one internal transport. Unlike transports that
  // dial external services, its existence is part of Nox rather than deployment
  // configuration; bootstrap puts both halves together exactly once.
  const chat = new ChatHub();
  const scheduledRuns = new ScheduledRunRelay();

  const application = new NoxApplication({
    extensions: [
      englishLanguageExtension,
      spanishLanguageExtension,
      webBrokerExtension,
      sharpImageExtension,
      openAIExtension,
      cronJobsExtension,
      webToolsExtension,
    ],
    logger,
  })
    .provide(artifactPipelineService, artifactPipeline)
    .provide(chatHubService, chat)
    .provide(configService, config)
    .provide(databaseService, database)
    .provide(loggerService, logger)
    .provide(scheduledRunHostService, scheduledRuns)
    .provide(secretStoreService, secretStore);

  // Owned before anything activates, so it is released last: an extension handed
  // the database as a service lets go of it before the file closes.
  application.own(toDisposable(() => database.close()));
  application.own(scheduledRuns);

  // One catalog for the whole process: the agents are composed from it, and the
  // surface that validates a blueprint asks it the same question the agents
  // did. Everything it reads is deferred, because none of it exists yet.
  const toolSetCatalog = new ToolSetCatalog({
    configured: () => config.get('toolSets'),
    contributions: application.contributions,
    runtimeSignature: () => ({ timeZone: config.get('app').timezone }),
    secretStore,
  });

  // Registered after the database and therefore released before it: the socket
  // stops answering while the storage its answers came from is still open.
  const auth = await openAuth(appConfig.auth, database, env.dataDir, logger);
  const configuration = new ConfigStore({
    authorities: () => buildAuthorityCatalog(application),
    config,
    contributions: application.contributions,
    runtime: configurationRuntime,
    toolSets: toolSetCatalog,
  });
  const api = application.own(
    openApi(
      application,
      appConfig.api,
      () => config.get('app').ui.locale,
      auth,
      artifactPipeline,
      chat,
      configuration,
      database,
      secretStore,
      env.uiDir,
      logger,
    ),
  );

  // Registered last so it is silenced before the API, storage, and services it
  // may reconcile during shutdown.
  if (env.configWatch) {
    const watcher = openConfigWatcher(
      env.configDir,
      configuration,
      logger,
      env.configWatchDebounceMs,
      application.signal,
    );
    if (watcher !== undefined) application.own(watcher);
  }

  try {
    const catalog = await activateConfiguration(application, config, logger);
    const runtime = new ConfigurationRuntimeController({
      application,
      artifacts: artifactPipeline,
      authorities: catalog,
      config,
      contributions: application.contributions,
      createBroker: (brokerId) =>
        composeBrokerGrant(application, config, catalog, brokerId, secretStore),
      database,
      logger,
      secretStore,
      toolSets: toolSetCatalog,
    });
    configurationRuntime.connect(runtime);

    // The control plane comes up before optional runtime components. A broken
    // provider, agent or broker must remain repairable from a headless install.
    await api.listen();

    await openGateway(application, database, logger, runtime, scheduledRuns)
      .then((gateway) => {
        runtime.connectGateway(gateway);
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, 'Message gateway configuration did not activate.');
      });

    await runtime.reconcile().catch((error: unknown) => {
      logger.error({ err: error }, 'Runtime configuration reconciliation failed.');
    });
  } catch (error) {
    // Critical control-plane composition failed. Once the API is listening,
    // optional runtime failures are caught above and never reach this guard.
    await application.stop();
    throw error;
  }

  return application;
}

/**
 * The HTTP surface and repair plane. It opens once storage, authentication and
 * contributed schemas are available; agents and transports reconcile afterwards.
 */
function openApi(
  application: NoxApplication,
  config: ApiConfig,
  locale: () => string | undefined,
  auth: ApiAuth,
  artifacts: ArtifactPipeline,
  chat: ChatHub,
  configuration: ConfigStore,
  database: Database,
  secrets: SecretStore,
  uiDirectory: string,
  logger: Logger,
): ApiServer {
  return ApiServer.create({
    ...config,
    artifacts,
    auth,
    chat,
    checks: {
      database: () => database.isOpen,
      nox: () => application.state === 'running',
    },
    config: configuration,
    languages: application.contributions,
    locale,
    logger: logger.child('api'),
    secrets,
    uiDirectory,
    version: application.noxVersion,
  });
}

/**
 * Who may reach the HTTP surface, and — for an installation nobody has claimed
 * yet — the code that decides who gets to be first. The window is opened only
 * when there is no account: a code printed on every restart of a Nox that
 * already has one is noise that teaches the operator to skim past it.
 */
async function openAuth(
  config: AuthConfig,
  database: Database,
  dataDirectory: string,
  logger: Logger,
): Promise<ApiAuth> {
  const authLogger = logger.child('auth');
  const store = await AuthStore.open({ ...config, database, dataDirectory, logger: authLogger });
  const registration = (await store.isRegistered())
    ? RegistrationWindow.closed()
    : RegistrationWindow.open(authLogger);

  return { registration, store };
}

/**
 * Every authority this Nox knows: the core's own, plus one per contribution at
 * the authorities point. Ownership is not something an extension asserts about
 * itself — the registry recorded who registered what, and the catalog checks
 * that each name sits inside that owner's namespace.
 */
function buildAuthorityCatalog(application: NoxApplication): AuthorityCatalog {
  const contributed: AuthorityDefinition[] = application.contributions
    .list(authorities)
    .map((contribution) => ({
      description: contribution.value.description,
      id: contribution.id,
      ownerExtensionId: contribution.extensionId,
    }));

  return AuthorityCatalog.from([...CORE_AUTHORITIES, ...contributed]);
}

/** Activates extensions, resolves contributed schemas and materializes built-in entries. */
async function activateConfiguration(
  application: NoxApplication,
  config: Config,
  logger: Logger,
): Promise<AuthorityCatalog> {
  await application.start();

  // Only now do contributed config sections have schemas: each is the union of
  // what the extensions just contributed, and before activation there was
  // nothing to validate them against.
  await config.resolveAvailable(application.contributions);

  // Web existed before brokers were configurable. Materialize its built-in entry
  // for a fresh or pre-contribution configuration; operators may disable it, but
  // it remains addressable and visible beside every other broker. A malformed
  // mounted brokers document is left untouched and repairable through reload.
  if (config.loaded.includes('brokers') && config.get('brokers')[WEB_BROKER_ID] === undefined) {
    try {
      await config.updateInstance('brokers', WEB_BROKER_ID, { type: 'web' });
    } catch (error) {
      // A read-only mounted document may not be materializable. Web chat stays
      // unavailable, but the API and Settings remain up so the mount can be repaired.
      logger.error({ err: error }, 'The built-in Web broker could not be materialized.');
    }
  }

  // Likewise the catalog: an authority an extension has not contributed yet does
  // not exist, and a tool naming one fails here rather than at call time.
  const catalog = buildAuthorityCatalog(application);

  return catalog;
}

/** Composes one immutable broker generation from its current desired entry. */
async function composeBrokerGrant(
  application: NoxApplication,
  config: Config,
  catalog: AuthorityCatalog,
  brokerId: string,
  secretStore: SecretStore,
): Promise<BrokerGrant> {
  const entry = config.get('brokers')[brokerId];
  if (entry === undefined) throw new Error(`Broker "${brokerId}" is not configured.`);

  const contribution = application.contributions.get(brokers, entry.type);
  if (contribution === undefined) {
    throw new Error(
      `Broker "${brokerId}" is of type "${entry.type}", which no extension contributed.`,
    );
  }

  const isWeb = brokerId === WEB_BROKER_ID && entry.type === 'web';
  if (entry.type === 'web' && !isWeb) {
    throw new Error(`The built-in Web broker must use the reserved ID "${WEB_BROKER_ID}".`);
  }
  if (isWeb && Object.keys(entry.grants).length > 0) {
    throw new Error('Web authority comes from the authenticated owner, not configured grants.');
  }

  const availableDesiredAgents = Object.keys(config.get('blueprints')).filter(
    (agentId) => application.getAgent(agentId) !== undefined,
  );
  const onlyAgent = availableDesiredAgents.length === 1 ? availableDesiredAgents[0] : undefined;
  const agentId = entry.agent ?? (isWeb ? onlyAgent : undefined);
  if (agentId !== undefined && application.getAgent(agentId) === undefined) {
    throw new Error(
      `Broker "${brokerId}" answers as agent "${agentId}", which no blueprint defines.`,
    );
  }
  if (!isWeb && agentId === undefined) {
    throw new Error(`Broker "${brokerId}" requires a base agent.`);
  }

  const conversationGrants = Object.fromEntries(
    Object.entries(entry.conversations).map(([conversationId, override]) => {
      const conversationAgentId = override.agent ?? agentId;
      if (
        conversationAgentId !== undefined &&
        application.getAgent(conversationAgentId) === undefined
      ) {
        throw new Error(
          `Conversation "${conversationId}" on broker "${brokerId}" answers as agent ` +
            `"${conversationAgentId}", which no blueprint defines.`,
        );
      }
      if (isWeb && Object.keys(override.grants).length > 0) {
        throw new Error(
          `Web conversation "${conversationId}" cannot replace owner authority with grants.`,
        );
      }

      return [
        conversationId,
        Object.freeze({
          ...(conversationAgentId === undefined ? {} : { agentId: conversationAgentId }),
          authorization: isWeb
            ? new OwnerAuthorizationProvider(brokerId)
            : new GrantAuthorizationProvider(
                brokerId,
                override.grants,
                catalog,
                `grants:${brokerId}:${conversationId}`,
              ),
        }),
      ] as const;
    }),
  );

  return Object.freeze({
    ...(agentId === undefined ? {} : { agentId }),
    authorization: isWeb
      ? new OwnerAuthorizationProvider(brokerId)
      : new GrantAuthorizationProvider(brokerId, entry.grants, catalog, `grants:${brokerId}`),
    broker: await composeWithSecrets(
      entry,
      secretStore,
      { extensionId: contribution.extensionId, location: `brokers.${brokerId}` },
      (resolved) => contribution.value.create(resolved),
    ),
    brokerId,
    conversations: Object.freeze(conversationGrants),
    ...(isWeb ? { selectableAgent: true } : {}),
  });
}

/** Opens the stable gateway host; configured broker generations reconcile into it afterwards. */
async function openGateway(
  application: NoxApplication,
  database: Database,
  logger: Logger,
  runtime: ConfigurationRuntimeController,
  scheduledRuns: ScheduledRunRelay,
): Promise<Gateway> {
  const gateway = new Gateway(application, {
    brokers: [],
    brokerStatus: (brokerId, state, error) => {
      runtime.reportBroker(brokerId, state, error);
    },
    database,
    logger: logger.child('gateway'),
  });
  application.setGateway(gateway);
  await gateway.start();
  scheduledRuns.connect(gateway);
  return gateway;
}

/** Optional assistance for mounted files; explicit `/config/reload` remains authoritative. */
function openConfigWatcher(
  configDirectory: string,
  configuration: ConfigStore,
  logger: Logger,
  debounceMs: number,
  signal: AbortSignal,
): ReturnType<typeof toDisposable> | undefined {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const watcher = watch(configDirectory, { recursive: true }, () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void configuration.reloadConfiguration().catch((error: unknown) => {
          logger.error({ err: error }, 'Watched configuration reload failed.');
        });
      }, debounceMs);
    });
    (
      watcher as unknown as {
        on(event: 'error', listener: (error: Error) => void): void;
      }
    ).on('error', (error) => {
      logger.error({ err: error }, 'Configuration watcher failed.');
    });
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', close);
      watcher.close();
    };
    signal.addEventListener('abort', close, { once: true });
    return toDisposable(close);
  } catch (error) {
    logger.error({ err: error }, 'Configuration watcher could not start.');
    return undefined;
  }
}

export { bootstrap };

export type { BootstrapOptions };
