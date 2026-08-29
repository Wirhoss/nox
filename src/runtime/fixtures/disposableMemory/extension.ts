import { appendFileSync } from 'node:fs';

import {
  defineExtension,
  type Disposable,
  memories,
  type Memory,
  memoryContribution,
  z,
} from '@nox/extension-api';

/**
 * A memory that records its own release.
 *
 * Disposal is invisible from outside the process, so the only way to assert the
 * runtime performs it is to have the instance say so where a test can read it.
 */
const configSchema = z.object({
  /** File this instance appends its id to when the runtime releases it. */
  ledger: z.string().min(1),
  type: z.literal('disposable_test'),
});

const disposableMemoryExtension = defineExtension({
  activate(context) {
    context.contributions.register(
      memories,
      'disposable_test',
      memoryContribution({
        configSchema,
        create: (config): Disposable & Memory => ({
          dispose(): void {
            appendFileSync(config.ledger, 'released\n');
          },
          recall: () => ({ memories: [] }),
          retain: () => undefined,
        }),
      }),
    );
  },
});

export default disposableMemoryExtension;
export { disposableMemoryExtension };
