import { watch } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { authorities, brokers } from '@nox/extension-api';

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
import { backfillDerivedIndexes, SessionStore } from './database/sessionStore';
import { toDisposable } from './extensions/disposable';
import { discoverExtensions } from './extensions/loader';
import { DatabaseExtensionStorageProvider } from './extensions/storage';
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
  configAdminService,
  configService,
  loggerService,
  scheduledRunHostService,
  secretStoreService,
} from './services';
import { NOX_VERSION } from './version';

import type { AuthConfig } from './api/auth/config';
import type { ApiConfig } from './api/serverConfig';
import type { ExtensionCatalog } from './extensions/catalog';

const BUILTIN_EXTENSIONS_DIRECTORY = join(import.meta.dir, 'extensions', 'builtin');

interface BootstrapOptions {
  env?: EnvSource;
  /** Defaults to a logger at the configured level; tests pass a silent one. */
  logger?: Logger;
}

/**
 * The composition root of the process: the one place allowed to name concrete
 * capabilities. It reads the environment, loads configuration, opens storage,
 * hands all three to the application as services, discovers builtin and
 * installed extension packages through one loader, builds configured runtime
 * components from their contributions, and registers one agent per blueprint.
 * Nothing below it imports a concrete extension.
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

  await Promise.all([
    mkdir(env.dataDir, { recursive: true }),
    mkdir(env.extensionsDir, { recursive: true }),
  ]);
  const database = await Database.open({
    ...appConfig.database,
    logger,
    path: isAbsolute(appConfig.database.path)
      ? appConfig.database.path
      : join(env.dataDir, appConfig.database.path),
  });
  // Before anything opens a session: a rebuild reads every stored message, and
  // doing that under a live transcript would race the appends it is indexing.
  await backfillDerivedIndexes(database, logger);

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

  const discovered = await discoverExtensions({
    directories: [
      { directory: BUILTIN_EXTENSIONS_DIRECTORY, origin: 'builtin' },
      { directory: env.extensionsDir, origin: 'installed' },
    ],
    logger: logger.child('extensions'),
    noxVersion: NOX_VERSION,
  });

  const application = new NoxApplication({
    extensions: discovered.extensions,
    logger,
    noxVersion: NOX_VERSION,
    storage: new DatabaseExtensionStorageProvider(database),
  })
    .provide(artifactPipelineService, artifactPipeline)
    .provide(chatHubService, chat)
    .provide(configService, config)
    .provide(loggerService, logger)
    .provide(scheduledRunHostService, scheduledRuns)
    .provide(secretStoreService, secretStore);

  // Owned before anything activates, so extension state and host services stop
  // using the database before the file closes.
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
  application.provide(configAdminService, configuration);
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
      discovered.catalog,
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
    const catalog = await activateConfiguration(application, config);
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
  extensions: ExtensionCatalog,
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
    contributions: application.contributions,
    extensions,
    languages: application.contributions,
    locale,
    logger: logger.child('api'),
    secrets,
    sessions: new SessionStore(database, { logger: logger.child('sessions') }),
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

/** Activates discovered extensions and resolves the schemas they contributed. */
async function activateConfiguration(
  application: NoxApplication,
  config: Config,
): Promise<AuthorityCatalog> {
  await application.start();

  // Only now do contributed config sections have schemas: each is the union of
  // what the extensions just contributed, and before activation there was
  // nothing to validate them against.
  await config.resolveAvailable(application.contributions);

  // Likewise the catalog: an authority an extension has not contributed yet does
  // not exist, and a tool naming one fails here rather than at call time.
  return buildAuthorityCatalog(application);
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

  // Whether this type may be configured more than once, and under what name, is
  // settled when the section is validated: a single-instance contribution owns
  // its own name, so `web` is reserved by being called `web` rather than by a
  // rule that only brokers have.
  const host = contribution.value.host;
  const ownerAuthorized = host?.authorization === 'owner';
  if (ownerAuthorized && Object.keys(entry.grants).length > 0) {
    throw new Error('Owner-authenticated brokers cannot replace owner authority with grants.');
  }

  const availableDesiredAgents = Object.keys(config.get('blueprints')).filter(
    (agentId) => application.getAgent(agentId) !== undefined,
  );
  const onlyAgent = availableDesiredAgents.length === 1 ? availableDesiredAgents[0] : undefined;
  const agentId = entry.agent ?? (host?.selectableAgent === true ? onlyAgent : undefined);
  if (agentId !== undefined && application.getAgent(agentId) === undefined) {
    throw new Error(
      `Broker "${brokerId}" answers as agent "${agentId}", which no blueprint defines.`,
    );
  }
  if (host?.selectableAgent !== true && agentId === undefined) {
    throw new Error(`Broker "${brokerId}" requires a base agent.`);
  }

  // Built before the authorization providers, which close over it: a transport
  // that knows about groups answers `principalGroups` from state it keeps while
  // it runs, so the provider needs the instance rather than a copy of anything.
  const broker = await composeWithSecrets(
    entry,
    secretStore,
    { extensionId: contribution.extensionId, location: `brokers.${brokerId}` },
    (resolved) => contribution.value.create(resolved),
  );

  // Late-bound on purpose. The broker is asked at the moment of the call, so
  // membership that changed mid-session is reflected without anything having to
  // rebuild a provider.
  const groups = (subject: string): readonly string[] => broker.principalGroups?.(subject) ?? [];

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
      if (ownerAuthorized && override.grants !== undefined) {
        throw new Error(
          `Owner-authenticated conversation "${conversationId}" cannot replace owner authority with grants.`,
        );
      }

      // Absent inherits the broker's grants; `{}` is an explicit "nobody here".
      // The two used to be the same value, which made an override that only
      // redirects the agent revoke every grant in that conversation.
      const conversationGrantsEntry = override.grants ?? entry.grants;

      return [
        conversationId,
        Object.freeze({
          ...(conversationAgentId === undefined ? {} : { agentId: conversationAgentId }),
          authorization: ownerAuthorized
            ? new OwnerAuthorizationProvider(brokerId)
            : new GrantAuthorizationProvider(
                brokerId,
                conversationGrantsEntry,
                catalog,
                `grants:${brokerId}:${conversationId}`,
                groups,
              ),
        }),
      ] as const;
    }),
  );

  return Object.freeze({
    ...(agentId === undefined ? {} : { agentId }),
    authorization: ownerAuthorized
      ? new OwnerAuthorizationProvider(brokerId)
      : new GrantAuthorizationProvider(
          brokerId,
          entry.grants,
          catalog,
          `grants:${brokerId}`,
          groups,
        ),
    broker,
    brokerId,
    conversations: Object.freeze(conversationGrants),
    ...(host?.selectableAgent === true ? { selectableAgent: true } : {}),
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
