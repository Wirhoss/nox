import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { Agent } from './agent/agent';
import { ApiServer } from './api/server';
import { NoxApplication } from './application';
import { Config } from './config/config';
import { type EnvSource, readEnvConfig } from './config/env';
import { Database } from './database/database';
import { openAIExtension } from './extensions/builtin/providers/openai/extension';
import { webToolsExtension } from './extensions/builtin/toolsets/web/extension';
import { brokers } from './extensions/contribution-points/brokers';
import { type ProviderConfig, providers } from './extensions/contribution-points/providers';
import { type ToolSetConfig, toolSets } from './extensions/contribution-points/toolsets';
import { toDisposable } from './extensions/disposable';
import { type BrokerGrant, Gateway } from './gateway/gateway';
import { createLogger, type Logger } from './logger/logger';
import { configService, databaseService, loggerService } from './services';

import type { ApiConfig } from './api/config';
import type { Blueprint } from './config/blueprint';
import type { ModelConfig } from './provider/config';
import type { ChatProvider } from './provider/provider';
import type { ToolSet, ToolSetGrant } from './tool/tool';

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

  const application = new NoxApplication({
    extensions: [openAIExtension, webToolsExtension],
    logger,
  })
    .provide(configService, config)
    .provide(databaseService, database)
    .provide(loggerService, logger);

  // Owned before anything activates, so it is released last: an extension handed
  // the database as a service lets go of it before the file closes.
  application.own(toDisposable(() => database.close()));

  // Registered after the database and therefore released before it: the socket
  // stops answering while the storage its answers came from is still open.
  application.own(await openApi(application, appConfig.api, database, logger));

  try {
    await composeAgents(application, config, database, env.configDir, logger);
    await openGateway(application, config, database, logger);
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
 * The HTTP surface, listening before the application does. Liveness answers
 * while Nox is still starting, which is the point of the probe; readiness says
 * no until everything below is up, which is the point of that one.
 */
async function openApi(
  application: NoxApplication,
  config: ApiConfig,
  database: Database,
  logger: Logger,
): Promise<ApiServer> {
  return ApiServer.start({
    ...config,
    checks: {
      database: () => database.isOpen,
      nox: () => application.state === 'running',
    },
    logger: logger.child('api'),
    version: application.noxVersion,
  });
}

/** Activates the extensions and registers one agent per blueprint on disk. */
async function composeAgents(
  application: NoxApplication,
  config: Config,
  database: Database,
  configDir: string,
  logger: Logger,
): Promise<void> {
  await application.start();

  // Only now do contributed config sections have schemas: each is the union of
  // what the extensions just contributed, and before activation there was
  // nothing to validate them against.
  await config.resolve(application.contributions);

  const blueprints = config.get('blueprints');
  if (Object.keys(blueprints).length === 0) {
    throw new Error(`No agent is configured. Add a blueprint to ${join(configDir, 'blueprints')}.`);
  }

  const configuredProviders = config.get('providers');
  const configuredToolSets = config.get('toolSets');
  const openedProviders = new Map<string, ChatProvider>();
  const openedToolSets = new Map<string, ToolSet>();
  for (const [agentId, blueprint] of Object.entries(blueprints)) {
    const provider = openProvider(
      application,
      configuredProviders,
      openedProviders,
      blueprint.provider,
    );
    const model = modelConfigFor(provider, blueprint.model, blueprint.generation);
    const compactionProvider =
      blueprint.compaction === undefined
        ? provider
        : openProvider(
            application,
            configuredProviders,
            openedProviders,
            blueprint.compaction.provider,
          );
    const compactionModel =
      blueprint.compaction === undefined
        ? model
        : modelConfigFor(compactionProvider, blueprint.compaction.model);
    const directToolSets = grantToolSets(
      application,
      configuredToolSets,
      openedToolSets,
      blueprint.toolSets.direct,
    );
    const routedToolSets = grantToolSets(
      application,
      configuredToolSets,
      openedToolSets,
      blueprint.toolSets.routed,
    );

    application.addAgent(
      new Agent(database, provider, model, {
        agentId,
        compactionModel,
        compactionProvider,
        context: blueprint.context,
        directToolSets,
        gate: blueprint.gate,
        logger,
        maxIterations: blueprint.maxIterations,
        routedToolSets,
        systemPrompt: blueprint.systemPrompt,
      }),
    );
  }
}

/**
 * Opens the message gateway over whatever brokers are configured, and hands it
 * to the application so shutdown silences the transports before it closes the
 * conversations they feed. A Nox with no configured broker gets no gateway at
 * all — there is nothing for it to listen to.
 */
async function openGateway(
  application: NoxApplication,
  config: Config,
  database: Database,
  logger: Logger,
): Promise<void> {
  const configured = config.get('brokers');
  const grants: BrokerGrant[] = [];

  for (const [brokerId, entry] of Object.entries(configured)) {
    if (entry.enabled === false) continue;

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

    grants.push(
      Object.freeze({
        agentId: entry.agent,
        approvers: entry.approvers,
        broker: contribution.value.create(entry),
        brokerId,
      }),
    );
  }

  if (grants.length === 0) return;

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
function openProvider(
  application: NoxApplication,
  configured: Record<string, ProviderConfig>,
  opened: Map<string, ChatProvider>,
  providerId: string,
): ChatProvider {
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

  const provider = contribution.value.create(entry);
  opened.set(providerId, provider);
  return provider;
}

/** Opens configured tool-set instances once and grants them under their config IDs. */
function grantToolSets(
  application: NoxApplication,
  configured: Record<string, ToolSetConfig>,
  opened: Map<string, ToolSet>,
  toolSetIds: readonly string[],
): ToolSetGrant[] {
  const grants: ToolSetGrant[] = [];
  const seen = new Set<string>();

  for (const toolSetId of toolSetIds) {
    if (seen.has(toolSetId)) {
      throw new Error(`Tool set "${toolSetId}" is granted more than once in one blueprint list.`);
    }
    seen.add(toolSetId);

    let toolSet = opened.get(toolSetId);
    if (toolSet === undefined) {
      const entry = configured[toolSetId];
      if (entry === undefined) {
        const known = Object.keys(configured);
        throw new Error(
          `A blueprint names tool set "${toolSetId}", which toolsets.json does not ` +
            (known.length === 0
              ? 'configure at all.'
              : `configure. Configured: ${known.join(', ')}.`),
        );
      }

      const contribution = application.contributions.get(toolSets, entry.type);
      if (contribution === undefined) {
        throw new Error(
          `Tool set "${toolSetId}" is of type "${entry.type}", which no extension contributed.`,
        );
      }

      toolSet = contribution.value.create(entry);
      opened.set(toolSetId, toolSet);
    }

    grants.push(Object.freeze({ toolSet, toolSetId }));
  }

  return grants;
}

/**
 * The model an agent runs on. Its budget comes from the provider entry that
 * declared it — `contextWindow` is a property of a model, and Law 2 needs it to
 * fold before it compacts — so a model the configuration never described runs
 * without one rather than with a guess.
 */
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
