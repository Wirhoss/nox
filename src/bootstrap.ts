import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { Agent } from './agent/agent';
import { NoxApplication } from './application';
import { Config } from './config/config';
import { type EnvSource, readEnvConfig } from './config/env';
import { Database } from './database/database';
import { openAIExtension } from './extensions/builtin/openai/extension';
import { type ProviderConfig, providers } from './extensions/contribution-points/providers';
import { toDisposable } from './extensions/disposable';
import { createLogger, type Logger } from './logger/logger';
import { configService, databaseService, loggerService } from './services';

import type { Blueprint } from './config/blueprint';
import type { ModelConfig } from './provider/config';
import type { ChatProvider } from './provider/provider';

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

  const application = new NoxApplication({ extensions: [openAIExtension], logger })
    .provide(configService, config)
    .provide(databaseService, database)
    .provide(loggerService, logger);

  // Owned before anything activates, so it is released last: an extension handed
  // the database as a service lets go of it before the file closes.
  application.own(toDisposable(() => database.close()));

  await application.start();

  // Only now does `providers.json` have a schema: it is the union of what the
  // extensions just contributed, and before activation there was nothing to
  // validate it against.
  await config.resolve(application.contributions);

  const blueprints = config.get('blueprints');
  if (Object.keys(blueprints).length === 0) {
    throw new Error(
      `No agent is configured. Add a blueprint to ${join(env.configDir, 'blueprints')}.`,
    );
  }

  const opened = new Map<string, ChatProvider>();
  for (const [agentId, blueprint] of Object.entries(blueprints)) {
    const provider = openProvider(application, config.get('providers'), opened, blueprint);
    const model = modelConfigFor(provider, blueprint.model, blueprint.generation);
    const compactionModel =
      blueprint.compaction.model === undefined
        ? model
        : modelConfigFor(provider, blueprint.compaction.model);

    application.addAgent(
      new Agent(database, provider, model, {
        agentId,
        compactionModel,
        context: blueprint.context,
        gate: blueprint.gate,
        logger,
        maxIterations: blueprint.maxIterations,
        systemPrompt: blueprint.systemPrompt,
      }),
    );
  }

  return application;
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
  blueprint: Blueprint,
): ChatProvider {
  const existing = opened.get(blueprint.provider);
  if (existing !== undefined) return existing;

  const entry = configured[blueprint.provider];
  if (entry === undefined) {
    const known = Object.keys(configured);
    throw new Error(
      `A blueprint names provider "${blueprint.provider}", which providers.json does not ` +
        (known.length === 0 ? 'configure at all.' : `configure. Configured: ${known.join(', ')}.`),
    );
  }

  const contribution = application.contributions.get(providers, entry.type);
  if (contribution === undefined) {
    throw new Error(
      `Provider "${blueprint.provider}" is of type "${entry.type}", which no extension contributed.`,
    );
  }

  const provider = contribution.value.create(entry);
  opened.set(blueprint.provider, provider);
  return provider;
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
