import * as dotenv from 'dotenv';
dotenv.config({ quiet: true });

import { AgentRegistry } from './src/agent/registry';
import { Config } from './src/config';
import { DeepResearchRegistry } from './src/deepResearch';
import { DeliberationRegistry } from './src/deliberation';
import { BrokerRegistry, MessageGateway } from './src/gateway';
import logger from './src/logger';
import { ProviderRegistry } from './src/provider';
import { startServer } from './src/server';
import { ToolRegistry } from './src/tool/registry';

import type { NoxServer } from './src/server';

let server: NoxServer | null = null;
let shuttingDown = false;

async function main(): Promise<void> {
  logger.info('Starting nox...');
  await Config.init();
  await ProviderRegistry.instance.init(Config.get('providers'));
  await ToolRegistry.instance.init(Config.get('tools'));
  const appConfig = Config.get('app');
  await AgentRegistry.instance.init(
    Config.get('blueprints'),
    Config.get('env').databaseFile,
    appConfig.gate,
    appConfig.runner,
  );
  DeepResearchRegistry.instance.init(Config.get('env').databaseFile);
  DeliberationRegistry.instance.init(Config.get('env').databaseFile);
  // TODO: read broker configs from Config once the first concrete broker exists.
  await BrokerRegistry.instance.init({}, MessageGateway.instance);

  const { host, port } = appConfig.server;
  server = await startServer({ host, port, uiDir: Config.get('env').uiDir });
  logger.info(`nox started on http://${host}:${port}`);
}

async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await server?.stop();
  await BrokerRegistry.instance.stopAll();
  await DeliberationRegistry.instance.close();
  DeepResearchRegistry.instance.close();
  AgentRegistry.instance.close();
}

process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'Unhandled promise rejection');
  process.exit(1);
});
process.on('uncaughtException', (error) => {
  logger.fatal({ error }, 'Uncaught exception');
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'Shutting down');
    shutdown()
      .catch((error) => logger.error({ err: error }, 'Error during shutdown'))
      .finally(() => process.exit(0));
  });
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    logger.error({ stack: (error as Error).stack }, 'Failed to start nox');
    await shutdown().catch(() => {});
    process.exitCode = 1;
  }
}
