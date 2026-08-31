import { appendFileSync } from 'node:fs';

import { defineExtension, memories, memoryContribution, z } from '@nox/extension-api';

import type { Disposable, Memory } from '@nox/extension-api';

/**
 * A memory that runs work of its own between conversations, and records both
 * that it was released and that its release was waited for.
 *
 * Consolidation is the implementation's, not the host's — a memory that folds
 * duplicates or ages facts out does it on its own clock, using the disposal
 * every contribution already has. So the thing worth asserting is not that
 * `dispose` is called but that it is *awaited*: a background pass cut off
 * midway is a half-written store, and nothing outside this process can see the
 * difference unless the instance says so.
 */
const configSchema = z.object({
  /** File this instance appends to when the runtime has finished releasing it. */
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
        create: (config): Disposable & Memory => {
          let passes = 0;
          const background = setInterval(() => {
            passes += 1;
          }, 5);

          return {
            async dispose(): Promise<void> {
              clearInterval(background);
              const stopped = passes;
              await new Promise((resolve) => setTimeout(resolve, 15));
              // One line, written last, carrying the verdict: the file existing
              // at all proves the wait happened, and its content proves the work
              // had actually stopped rather than merely been asked to.
              appendFileSync(config.ledger, passes === stopped ? 'released\n' : 'still-running\n');
            },
            recall: () => ({ memories: [] }),
            retain: () => undefined,
          };
        },
      }),
    );
  },
});

export default disposableMemoryExtension;
export { disposableMemoryExtension };
