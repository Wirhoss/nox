import { bootstrap } from './src/bootstrap';
import { loggerService } from './src/services';

async function run(): Promise<void> {
  const application = await bootstrap();
  const logger = application.services.get(loggerService);
}

try {
  await run();
} catch (error) {
  // The entry point is the last place an error can still be readable.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
