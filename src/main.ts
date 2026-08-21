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
import { createLogger, type Logger } from './logger/logger';
import { parseOrThrow } from './utils/validate';

import type { Session } from './agent/session';

const DEFAULT_SYSTEM_PROMPT =
  'You are Nox, a precise assistant. Answer directly and admit what you do not know.';

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

/** One booted Nox: everything wired, nothing talked to yet. */
interface NoxRuntime {
  agent: Agent;
  application: NoxApplication;
  database: Database;
  logger: Logger;
  shutdown(): Promise<void>;
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
 * activates the builtin extensions, resolves a provider from what they
 * contributed, and hands back an agent. Nothing below it imports a builtin.
 */
async function bootstrap(options: BootstrapOptions = {}): Promise<NoxRuntime> {
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

  const application = new NoxApplication({ extensions: [openAIExtension], logger });
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

  const agent = new Agent(
    database,
    provider,
    { contextWindow: providerEnv.contextWindow, modelId: providerEnv.modelId, type: 'text' },
    { logger, systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
  );

  let stopped = false;
  return {
    agent,
    application,
    database,
    logger,
    // Reverse of construction: extensions release what they own before the
    // storage they were handed goes away.
    async shutdown(): Promise<void> {
      if (stopped) return;
      stopped = true;
      await application.stop();
      await database.close();
    },
  };
}

/** Yields complete lines, so a message split across chunks arrives whole. */
async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? '';
    for (const part of parts) yield part;
  }

  buffer += decoder.decode();
  if (buffer.length > 0) yield buffer;
}

/** Streams the model's reply to stdout; the logger owns stderr. */
async function printReplies(session: Session, logger: Logger): Promise<void> {
  for await (const event of session.events) {
    switch (event.type) {
      case 'assistantTextFragment': {
        process.stdout.write(event.text);
        break;
      }
      case 'error': {
        logger.error({ err: event.error }, 'Session reported an error.');
        break;
      }
      case 'retry': {
        logger.warn(
          { attempt: event.attempt, delayMs: event.delayMs },
          'Provider request is being retried.',
        );
        break;
      }
      case 'assistantReasoningFragment':
      case 'message':
      case 'runCompleted':
      case 'runStarted':
      case 'usage': {
        // The transcript, the run boundaries and the token counts already reach
        // storage and the log. Stdout carries the conversation and nothing else.
        break;
      }
    }
  }
}

async function main(): Promise<void> {
  const runtime = await bootstrap();
  const session = await runtime.agent.openSession({ sessionId: process.env.NOX_SESSION_ID });
  const printing = printReplies(session, runtime.logger);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await session.stop();
    await printing;
    await runtime.shutdown();
  };

  process.on('SIGINT', () => {
    void stop().then(() => {
      process.exit(0);
    });
  });

  process.stdout.write(`nox · session ${session.sessionId} · /exit to quit\n\n> `);

  for await (const line of readLines(Bun.stdin.stream())) {
    const text = line.trim();
    if (text === '/exit') break;
    if (text.length === 0) {
      process.stdout.write('> ');
      continue;
    }

    session.send(text);
    await session.idle;
    process.stdout.write('\n\n> ');
  }

  await stop();
}

export { bootstrap, main };

export type { BootstrapOptions, NoxRuntime };
