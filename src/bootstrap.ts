import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { Agent } from './agent/agent';
import { RegistrationWindow } from './api/auth/registration';
import { AuthStore } from './api/auth/store';
import { ChatHub } from './api/chat/transport';
import { ConfigStore } from './api/config/store';
import { type ApiAuth, ApiServer } from './api/server';
import { NoxApplication } from './application';
import { AuthorityCatalog, type AuthorityDefinition } from './auth/authority';
import { GrantAuthorizationProvider, OwnerAuthorizationProvider } from './auth/authorization';
import { CORE_AUTHORITIES } from './auth/coreAuthorities';
import { Config } from './config/config';
import { type EnvSource, readEnvConfig } from './config/env';
import { resolveSecrets, SecretStore } from './config/secrets';
import { Database } from './database/database';
import { WebBroker } from './extensions/builtin/brokers/web/webBroker';
import { openAIExtension } from './extensions/builtin/providers/openai/extension';
import { webToolsExtension } from './extensions/builtin/toolsets/web/extension';
import { authorities } from './extensions/contribution-points/authorities';
import { brokers } from './extensions/contribution-points/brokers';
import { type ProviderConfig, providers } from './extensions/contribution-points/providers';
import { toDisposable } from './extensions/disposable';
import { ToolSetCatalog } from './extensions/toolSetCatalog';
import { type BrokerConversationGrant, type BrokerGrant, Gateway } from './gateway/gateway';
import { createLogger, type Logger } from './logger/logger';
import { configService, databaseService, loggerService, secretStoreService } from './services';

import type { AuthConfig } from './api/auth/config';
import type { ApiConfig } from './api/serverConfig';
import type { Blueprint, TaskModelConfig } from './config/blueprint';
import type { ModelConfig } from './provider/config';
import type { ChatProvider } from './provider/provider';

const WEB_BROKER_ID = 'web';

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

  await mkdir(env.dataDir, { recursive: true });
  const database = await Database.open({
    ...appConfig.database,
    logger,
    path: isAbsolute(appConfig.database.path)
      ? appConfig.database.path
      : join(env.dataDir, appConfig.database.path),
  });

  let secretStore: SecretStore;
  try {
    secretStore = await SecretStore.open({
      dataDirectory: env.dataDir,
      database,
      logger: logger.child('secrets'),
    });
  } catch (error) {
    await database.close();
    throw error;
  }

  // The HTTP chat surface owns one internal transport. Unlike transports that
  // dial external services, its existence is part of Nox rather than deployment
  // configuration; bootstrap puts both halves together exactly once.
  const chat = new ChatHub();

  const application = new NoxApplication({
    extensions: [openAIExtension, webToolsExtension],
    logger,
  })
    .provide(configService, config)
    .provide(databaseService, database)
    .provide(loggerService, logger)
    .provide(secretStoreService, secretStore);

  // Owned before anything activates, so it is released last: an extension handed
  // the database as a service lets go of it before the file closes.
  application.own(toDisposable(() => database.close()));

  // One catalog for the whole process: the agents are composed from it, and the
  // surface that validates a blueprint asks it the same question the agents
  // did. Everything it reads is deferred, because none of it exists yet.
  const toolSetCatalog = new ToolSetCatalog({
    configured: () => config.get('toolSets'),
    contributions: application.contributions,
    secretStore,
  });

  // Registered after the database and therefore released before it: the socket
  // stops answering while the storage its answers came from is still open.
  const auth = await openAuth(appConfig.auth, database, env.dataDir, logger);
  const api = application.own(
    openApi(
      application,
      appConfig.api,
      auth,
      chat,
      new ConfigStore({
        authorities: () => buildAuthorityCatalog(application),
        config,
        toolSets: toolSetCatalog,
      }),
      database,
      secretStore,
      env.uiDir,
      logger,
    ),
  );

  try {
    const catalog = await composeAgents(
      application,
      config,
      database,
      env.configDir,
      logger,
      secretStore,
      toolSetCatalog,
    );
    await openGateway(
      application,
      config,
      catalog,
      chat,
      appConfig.chat.defaultAgent,
      database,
      logger,
      secretStore,
    );

    // Last, and inside the same guard as everything above: a port that is
    // answering means the runtime behind it is composed, and a Nox that failed
    // to compose never opened one.
    await api.listen();
  } catch (error) {
    // Everything above is already open. A bootstrap that throws leaves nothing
    // running — a half-composed Nox holding a port and a database file is worse
    // than one that never started.
    await application.stop();
    throw error;
  }

  return application;
}

/**
 * The HTTP surface, assembled here and opened last. Readiness still reports on
 * what it depends on rather than assuming it: everything below was up when the
 * port opened, and a database that goes away afterwards is exactly what the
 * probe is for.
 */
function openApi(
  application: NoxApplication,
  config: ApiConfig,
  auth: ApiAuth,
  chat: ChatHub,
  configuration: ConfigStore,
  database: Database,
  secrets: SecretStore,
  uiDirectory: string,
  logger: Logger,
): ApiServer {
  return ApiServer.create({
    ...config,
    auth,
    chat,
    checks: {
      database: () => database.isOpen,
      nox: () => application.state === 'running',
    },
    config: configuration,
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

/** Activates the extensions and registers one agent per blueprint on disk. */
async function composeAgents(
  application: NoxApplication,
  config: Config,
  database: Database,
  configDir: string,
  logger: Logger,
  secretStore: SecretStore,
  toolSetCatalog: ToolSetCatalog,
): Promise<AuthorityCatalog> {
  await application.start();

  // Only now do contributed config sections have schemas: each is the union of
  // what the extensions just contributed, and before activation there was
  // nothing to validate them against.
  await config.resolve(application.contributions);

  // Likewise the catalog: an authority an extension has not contributed yet does
  // not exist, and a tool naming one fails here rather than at call time.
  const catalog = buildAuthorityCatalog(application);

  const blueprints = config.get('blueprints');
  if (Object.keys(blueprints).length === 0) {
    throw new Error(`No agent is configured. Add a blueprint to ${join(configDir, 'blueprints')}.`);
  }

  const configuredProviders = config.get('providers');
  const openedProviders = new Map<string, ChatProvider>();
  for (const [agentId, blueprint] of Object.entries(blueprints)) {
    const provider = await openProvider(
      application,
      configuredProviders,
      openedProviders,
      blueprint.provider,
      secretStore,
    );
    const model = modelConfigFor(provider, blueprint.model, blueprint.generation);
    const openTask = (task: TaskModelConfig | undefined): Promise<TaskModel> =>
      openTaskModel(task, { model, provider }, (providerId) =>
        openProvider(application, configuredProviders, openedProviders, providerId, secretStore),
      );
    const compactionModel = await openTask(blueprint.taskModels.compaction);
    const titleModel = await openTask(blueprint.taskModels.title);
    const directToolSets = await toolSetCatalog.grant(blueprint.toolSets.direct);
    const routedToolSets = await toolSetCatalog.grant(blueprint.toolSets.routed);

    application.addAgent(
      new Agent(database, provider, model, {
        agentId,
        authorities: catalog,
        compactionModel: compactionModel.model,
        compactionProvider: compactionModel.provider,
        context: blueprint.context,
        directToolSets,
        gate: blueprint.gate,
        logger,
        maxIterations: blueprint.maxIterations,
        routedToolSets,
        systemPrompt: blueprint.systemPrompt,
        titleModel: titleModel.model,
        titleProvider: titleModel.provider,
      }),
    );
  }

  return catalog;
}

/** The agent a new browser conversation uses until the UI offers a picker. */
function webAgentFor(application: NoxApplication, configured: string | undefined): string {
  if (configured !== undefined) {
    if (application.getAgent(configured) === undefined) {
      throw new Error(
        `Web chat names default agent "${configured}", which no blueprint defines. ` +
          `Defined: ${application.agentIds.join(', ')}.`,
      );
    }
    return configured;
  }

  const [only] = application.agentIds;
  if (application.agentIds.length === 1 && only !== undefined) return only;

  throw new Error(
    'Web chat needs a default agent because more than one blueprint is configured. ' +
      'Set app.chat.defaultAgent.',
  );
}

/**
 * Opens the message gateway over Nox's own web surface and any externally
 * configured brokers. The web transport is infrastructure: it is always first,
 * always named `web`, and never appears in brokers.json.
 */
async function openGateway(
  application: NoxApplication,
  config: Config,
  catalog: AuthorityCatalog,
  chat: ChatHub,
  defaultWebAgent: string | undefined,
  database: Database,
  logger: Logger,
  secretStore: SecretStore,
): Promise<void> {
  const configured = config.get('brokers');
  const grants: BrokerGrant[] = [
    Object.freeze({
      agentId: webAgentFor(application, defaultWebAgent),
      authorization: new OwnerAuthorizationProvider(WEB_BROKER_ID),
      broker: new WebBroker(chat),
      brokerId: WEB_BROKER_ID,
      conversations: Object.freeze({}),
    }),
  ];

  for (const [brokerId, entry] of Object.entries(configured)) {
    if (entry.enabled === false) continue;
    if (brokerId === WEB_BROKER_ID) {
      throw new Error('Broker ID "web" is reserved for Nox\'s built-in HTTP chat surface.');
    }

    const contribution = application.contributions.get(brokers, entry.type);
    if (contribution === undefined) {
      throw new Error(
        `Broker "${brokerId}" is of type "${entry.type}", which no extension contributed.`,
      );
    }
    if (application.getAgent(entry.agent) === undefined) {
      throw new Error(
        `Broker "${brokerId}" answers as agent "${entry.agent}", which no blueprint defines.`,
      );
    }

    const conversationGrants = Object.fromEntries(
      Object.entries(entry.conversations).map(([conversationId, override]) => {
        const agentId = override.agent ?? entry.agent;
        if (application.getAgent(agentId) === undefined) {
          throw new Error(
            `Conversation "${conversationId}" on broker "${brokerId}" answers as agent ` +
              `"${agentId}", which no blueprint defines.`,
          );
        }

        const resolved: BrokerConversationGrant = Object.freeze({
          agentId,
          authorization: new GrantAuthorizationProvider(
            brokerId,
            override.grants,
            catalog,
            `grants:${brokerId}:${conversationId}`,
          ),
        });
        return [conversationId, resolved] as const;
      }),
    );

    grants.push(
      Object.freeze({
        agentId: entry.agent,
        // Built once per base route and configured conversation. Every grant is
        // checked against the global catalog now rather than becoming a silent
        // permission that can never match.
        authorization: new GrantAuthorizationProvider(
          brokerId,
          entry.grants,
          catalog,
          `grants:${brokerId}`,
        ),
        broker: contribution.value.create(
          await resolveSecrets(entry, secretStore, {
            extensionId: contribution.extensionId,
            location: `brokers.${brokerId}`,
          }),
        ),
        brokerId,
        conversations: Object.freeze(conversationGrants),
      }),
    );
  }

  const gateway = new Gateway(application, {
    brokers: grants,
    database,
    logger: logger.child('gateway'),
  });
  application.setGateway(gateway);
  await gateway.start();
}

/**
 * Builds the provider instance a blueprint talks through, once per configured
 * instance: two agents naming the same one share the adapter, and the connection
 * settings behind it, rather than opening it twice.
 */
async function openProvider(
  application: NoxApplication,
  configured: Record<string, ProviderConfig>,
  opened: Map<string, ChatProvider>,
  providerId: string,
  secretStore: SecretStore,
): Promise<ChatProvider> {
  const existing = opened.get(providerId);
  if (existing !== undefined) return existing;

  const entry = configured[providerId];
  if (entry === undefined) {
    const known = Object.keys(configured);
    throw new Error(
      `A blueprint names provider "${providerId}", which providers.json does not ` +
        (known.length === 0 ? 'configure at all.' : `configure. Configured: ${known.join(', ')}.`),
    );
  }

  const contribution = application.contributions.get(providers, entry.type);
  if (contribution === undefined) {
    throw new Error(
      `Provider "${providerId}" is of type "${entry.type}", which no extension contributed.`,
    );
  }

  const provider = contribution.value.create(
    await resolveSecrets(entry, secretStore, {
      extensionId: contribution.extensionId,
      location: `providers.${providerId}`,
    }),
  );
  opened.set(providerId, provider);
  return provider;
}

/**
 * The model an agent runs on. Its budget comes from the provider entry that
 * declared it — `contextWindow` is a property of a model, and Law 2 needs it to
 * fold before it compacts — so a model the configuration never described runs
 * without one rather than with a guess.
 */
/** One internal task's provider and model, resolved against the agent's own. */
interface TaskModel {
  readonly model: ModelConfig;
  readonly provider: ChatProvider;
}

/**
 * What an internal task runs on. A blueprint that named nothing for it runs on
 * the agent's own provider and model; one that named only a model stays on the
 * agent's provider, which is the usual case — a cheaper model on the endpoint
 * already configured, rather than a second endpoint nobody asked for.
 *
 * The agent's `generation` settings are deliberately not carried over: they are
 * tuned for how the agent should answer people, and compaction and titling are
 * not the agent answering anybody.
 */
async function openTaskModel(
  task: TaskModelConfig | undefined,
  agent: TaskModel,
  open: (providerId: string) => Promise<ChatProvider>,
): Promise<TaskModel> {
  if (task === undefined) return agent;

  const provider = task.provider === undefined ? agent.provider : await open(task.provider);
  return { model: modelConfigFor(provider, task.model), provider };
}

function modelConfigFor(
  provider: ChatProvider,
  modelId: string,
  generation: Blueprint['generation'] = {},
): ModelConfig {
  const configured = provider.getModelConfig(modelId) ?? { modelId, type: 'text' };
  return { ...configured, ...generation };
}

export { bootstrap };

export type { BootstrapOptions };
