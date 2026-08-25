import { bootstrap } from './src/bootstrap';

async function run(): Promise<void> {
  await bootstrap();
}

try {
  await run();
} catch (error) {
  // The entry point is the last place an error can still be readable.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
