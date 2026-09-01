import { authorities, defineExtension, ToolSet, toolSets } from '@nox/extension-api';
import { z } from 'zod';

import type {
  ExtensionContext,
  MessageContent,
  Tool,
  ToolSet as ToolSetType,
} from '@nox/extension-api';

/**
 * A whole extension, for the activation tests: it activates, registers two
 * contributions, and reads a service it declared.
 *
 * One of the contributions carries a `refine`, which JSON Schema has no
 * notation for — so it is the case that proves the host validates loosely and
 * the child validates strictly, rather than the check disappearing.
 */

const parrotConfig = z
  .object({
    excitement: z.number().int().min(0).max(5).default(1),
    type: z.literal('parrot'),
    word: z.string().min(1),
  })
  .refine((value) => value.word !== 'forbidden', {
    error: 'That word is not repeatable.',
    path: ['word'],
  });

class ParrotToolSet extends ToolSet {
  readonly #word: string;

  constructor(word: string, excitement: number) {
    super('parrot', 'Repeats one word.');
    this.#word = `${word}${'!'.repeat(excitement)}`;
    this.addTools();
  }

  protected override addTools(): void {
    const parameters = z.object({ times: z.number().int().min(1).max(5) });
    const say: Tool<typeof parameters> = {
      authority: 'test.parrot.say',
      description: 'Repeats the configured word.',
      name: 'say',
      parameters,
      prepare: (params) => ({
        run: async (): Promise<MessageContent[]> =>
          await Promise.resolve([
            {
              text: Array.from({ length: params.times }, () => this.#word).join(' '),
              type: 'text',
            },
          ]),
        title: 'Say',
        type: 'immediate',
      }),
    };
    this.registerTool(say);
  }
}

/** What the extension saw when it asked for its services, for the test to read. */
let observed: undefined | { readonly logger: string; readonly undeclared: string };

export default defineExtension({
  activate: (context: ExtensionContext) => {
    // A service it declared, and one it did not. The second is the interesting
    // one: it must be refused by name rather than quietly answered.
    const logger = context.services.get({ id: 'nox.logger' });
    let undeclared = 'reached';
    try {
      context.services.get({ id: 'nox.model-access' });
    } catch (cause) {
      undeclared = cause instanceof Error ? cause.message : String(cause);
    }
    observed = { logger: typeof logger, undeclared };
    (logger as { info: (fields: object, message: string) => void }).info(
      { from: 'activate' },
      'the parrot woke up',
    );

    context.subscriptions.add(
      context.contributions.register(toolSets, 'parrot', {
        configSchema: parrotConfig as never,
        create: (config: z.infer<typeof parrotConfig>): ToolSetType =>
          new ParrotToolSet(config.word, config.excitement),
        instances: 'many',
      } as never),
    );

    context.contributions.register(authorities, 'test.parrot.say', {
      description: 'Let the parrot repeat its word.',
    });
  },
  /** What the extension saw when it asked for its services. */
  seen: (): unknown => observed,
});
