import {
  authorities,
  defineExtension,
  type MessageContent,
  type Tool,
  ToolSet,
  toolSetBaseConfigSchema,
  toolSetContribution,
  toolSets,
  z,
} from '@nox/extension-api';

const greetingConfigSchema = toolSetBaseConfigSchema.extend({
  salutation: z.string().trim().min(1).default('Hello'),
  type: z.literal('greeting'),
});

type GreetingConfig = z.input<typeof greetingConfigSchema>;

const GREET_AUTHORITY = 'example.greeting.use';

class GreetingToolSet extends ToolSet {
  static readonly configSchema = greetingConfigSchema;

  readonly #salutation: string;

  constructor(input: GreetingConfig) {
    const config = greetingConfigSchema.parse(input);
    super('Greeting', 'Produces a greeting without accessing host internals.', config.enabledTools);
    this.#salutation = config.salutation;
    this.addTools();
  }

  protected addTools(): void {
    const parameters = z.object({ name: z.string().trim().min(1) });
    const greet: Tool<typeof parameters> = {
      authority: GREET_AUTHORITY,
      description: 'Greet a named person.',
      name: 'greet',
      parameters,
      prepare: ({ name }) => ({
        run: (): Promise<MessageContent[]> =>
          Promise.resolve([{ text: `${this.#salutation}, ${name}!`, type: 'text' }]),
        title: `Greet ${name}`,
        type: 'immediate',
      }),
      risk: { effects: ['read'], reversible: true },
    };
    this.registerTool(greet);
  }
}

export default defineExtension({
  activate(context) {
    context.contributions.register(authorities, GREET_AUTHORITY, {
      description: 'Produce local greeting text.',
    });
    context.contributions.register(
      toolSets,
      'greeting',
      toolSetContribution({
        configSchema: GreetingToolSet.configSchema,
        create: (config) => new GreetingToolSet(config),
      }),
    );
  },
});
