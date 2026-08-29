import { appendFileSync } from 'node:fs';

import {
  defineExtension,
  ToolSet,
  toolSetBaseConfigSchema,
  toolSetContribution,
  toolSets,
  z,
} from '@nox/extension-api';

const configSchema = toolSetBaseConfigSchema.extend({
  /** File this instance appends to when the runtime releases it. */
  ledger: z.string().min(1),
  type: z.literal('disposable_test'),
});

/** A tool set that records its own release, so a test can observe one happening. */
class LedgerToolSet extends ToolSet {
  readonly #ledger: string;

  constructor(ledger: string) {
    super('disposable_test', 'Records its own release.');
    this.#ledger = ledger;
  }

  protected addTools(): void {
    // Nothing to expose: this instance exists to be released, not called.
  }

  public dispose(): void {
    appendFileSync(this.#ledger, 'released\n');
  }
}

const disposableToolSetExtension = defineExtension({
  activate(context) {
    context.contributions.register(
      toolSets,
      'disposable_test',
      toolSetContribution({
        configSchema,
        create: (config) => new LedgerToolSet(config.ledger),
      }),
    );
  },
});

export default disposableToolSetExtension;
export { disposableToolSetExtension };
