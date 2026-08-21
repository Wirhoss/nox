import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { z } from 'zod';

import { Agent } from './agent/agent';
import { NoxApplication } from './application';
import { Config } from './config/config';
import { type EnvSource, readEnvConfig } from './config/env';
import { Database } from './database/database';
import { openAIExtension } from './extensions/builtin/openai/extension';
import { providers } from './extensions/contribution-points/providers';
import { toDisposable } from './extensions/disposable';
import { createLogger, type Logger } from './logger/logger';
import { configService, databaseService, loggerService } from './services';
import { parseOrThrow } from './utils/validate';

const DEFAULT_SYSTEM_PROMPT =
  'You are Nox, a precise assistant. Answer directly and admit what you do not know.';

/** The agent every surface talks to until blueprints make more than one. */
const DEFAULT_AGENT_ID = 'default';

/**
 * Provider settings come from the environment rather than a config section: an
 * API key does not belong in a file on disk, and a second provider is what
 * earns a `providers.json`. This is the door until then.
 */
const providerEnvSchema = z.object({
  apiKey: z.string().min(1, 'Set OPENAI_API_KEY.'),
  baseUrl: z.string().min(1, 'Set OPENAI_BASE_URL or leave it unset for the default.'),
  /** The compaction budget. Without it nothing compacts — see NOX.md, Law 2. */
  contextWindow: z.number().int().positive().optional(),
  modelId: z.string().min(1, 'Set OPENAI_MODEL to the model id to talk to.'),
});

type ProviderEnv = z.infer<typeof providerEnvSchema>;

interface BootstrapOptions {
  env?: EnvSource;
  /** Defaults to a logger at the configured level; tests pass a silent one. */
  logger?: Logger;
  systemPrompt?: string;
}

function readProviderEnv(env: EnvSource): ProviderEnv {
  const contextWindow = env.OPENAI_CONTEXT_WINDOW;

  return parseOrThrow(providerEnvSchema, {
    apiKey: env.OPENAI_API_KEY ?? '',
    baseUrl: env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    contextWindow: contextWindow === undefined ? undefined : Number(contextWindow),
    modelId: env.OPENAI_MODEL ?? '',
  });
}

/**
 * The composition root of the process: the one place allowed to name concrete
 * capabilities. It reads the environment, loads configuration, opens storage,
 * hands all three to the application as services, activates the builtin
 * extensions, resolves a provider from what they contributed and registers the
 * agent it makes. Nothing below it imports a builtin.
 *
 * What comes back is the running Nox itself — the process holds one object, and
 * stopping it stops everything this function opened.
 */
async function bootstrap(options: BootstrapOptions = {}): Promise<NoxApplication> {
  const source = options.env ?? process.env;
  const env = readEnvConfig(source);
  const providerEnv = readProviderEnv(source);

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

  const contribution = application.contributions.get(providers, 'openai_completions');
  if (contribution === undefined) {
    throw new Error('No provider was contributed at nox.providers.');
  }

  const provider = contribution.value.create({
    apiKey: providerEnv.apiKey,
    baseUrl: providerEnv.baseUrl,
    defaultModel: providerEnv.modelId,
    type: 'openai_completions',
  });

  application.addAgent(
    DEFAULT_AGENT_ID,
    new Agent(
      database,
      provider,
      { contextWindow: providerEnv.contextWindow, modelId: providerEnv.modelId, type: 'text' },
      { logger, systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
    ),
  );

  return application;
}

export { bootstrap, DEFAULT_AGENT_ID };

export type { BootstrapOptions };
