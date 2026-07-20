import * as dotenv from 'dotenv';
dotenv.config({ quiet: true });

import { AgentRegistry } from './src/agent/registry';
import { Config } from './src/config';
import logger from './src/logger';
import { ProviderRegistry } from './src/provider';
import { ToolRegistry } from './src/tool/registry';

async function main(): Promise<void> {
  logger.info('Starting nox...');
  await Config.init();
  await ProviderRegistry.instance.init(Config.get('providers'));
  await ToolRegistry.instance.init();
  await AgentRegistry.instance.init(Config.get('agents'), Config.get('env').databaseFile);
  logger.info('nox started.');
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
    process.exit(0);
  });
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    logger.error({ stack: (error as Error).stack }, 'Failed to start nox');
    process.exitCode = 1;
  }
}