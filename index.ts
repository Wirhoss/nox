import { main } from './src/main';

try {
  await main();
} catch (error) {
  // The composition root is the last place an error can still be readable.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
