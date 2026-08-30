import { z } from 'zod';

import type {
  BrokerCommandSpec,
  Command,
  CommandContext,
  CommandInvocation,
  CommandRejection,
  CommandResult,
  JsonSchema,
  ToolRisk,
} from '@nox/extension-api';

/**
 * Something a person does to a conversation, rather than something they say.
 * A message — including a steer — is attributed, deduplicated and appended to
 * the transcript, because it is what someone said. A command is not in the
 * transcript at all: it acts on the conversation, and the model never reads it.
 *
 * Shaped like a tool on purpose: a name, a description and a zod schema is
 * already how this codebase describes a named operation with typed parameters,
 * and a command is that same problem with a person on the other end. A list
 * parameter, a multiple choice or a nested object costs nothing extra — the
 * schema is the whole declaration, and every surface derives what it draws
 * from it.
 */
interface BrokerCommand<T extends z.ZodObject = z.ZodObject> extends Omit<
  Command<T>,
  'authority' | 'risk'
> {
  /** Internal commands may omit authority/risk; extension contributions may not. */
  readonly authority?: string;
  readonly name: string;
  risk?(args: z.infer<T>): ToolRisk;
  run(context: CommandContext, args: z.infer<T>): Promise<CommandResult> | Promise<void>;
}

const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** Preserves a command's parameter schema at its declaration site. */
function brokerCommand<T extends z.ZodObject>(definition: BrokerCommand<T>): BrokerCommand<T> {
  return definition;
}

/** A validated invocation, or the reason it was refused. */
type CommandCheck =
  | { readonly args: Readonly<Record<string, unknown>>; readonly command: BrokerCommand }
  | { readonly rejection: CommandRejection };

/**
 * Stop, in its two honest readings.
 *
 * `run` is the ordinary "that's enough": the turn in flight is cut short and the
 * conversation stays exactly where it was — an agent that was told to stop is
 * still in the chat. `session` is the heavier one, and even it is not deletion.
 */
const stopCommand = brokerCommand({
  description: 'Stops the agent: the turn in flight, or the whole conversation.',
  name: 'stop',
  parameters: z.object({
    scope: z
      .enum(['run', 'session'])
      .default('run')
      .describe(
        'run cuts the turn in flight short and leaves the conversation open. ' +
          'session ends the conversation; its binding survives, so the next message ' +
          'reopens the same transcript.',
      ),
  }),
  run: async (context, { scope }): Promise<CommandResult> => {
    if (scope === 'session') {
      await context.close();
      return { text: 'Session closed. The next message will reopen this transcript.' };
    }

    const aborted = await context.abort();
    return { text: aborted ? 'Run stopped.' : 'There was no run in flight.' };
  },
});

/** What a Nox offers before anything is added to it. */
const BUILTIN_COMMANDS: readonly BrokerCommand[] = Object.freeze([stopCommand]);

/**
 * The commands one Nox offers, and the one place an invocation is checked.
 *
 * Validation lives here rather than at each surface for the reason the tool
 * catalog exists: a schema enforced in two places is enforced differently by
 * next month. A transport renders from `specs` and submits whatever it collected;
 * whether that fits is answered against the same declaration it rendered.
 */
class CommandCatalog {
  readonly #commands = new Map<string, BrokerCommand>();

  #specs?: readonly BrokerCommandSpec[];

  constructor(commands: readonly BrokerCommand[] = BUILTIN_COMMANDS) {
    for (const command of commands) {
      if (!COMMAND_NAME_PATTERN.test(command.name)) {
        throw new Error(
          `Command name "${command.name}" must be 1-32 lowercase letters, digits, or hyphens, and start with a letter.`,
        );
      }
      if (this.#commands.has(command.name)) {
        throw new Error(`Command "${command.name}" is registered more than once.`);
      }
      this.#commands.set(command.name, command);
    }
  }

  /** Every command, by name, for a surface that has to offer them. */
  public get specs(): readonly BrokerCommandSpec[] {
    this.#specs ??= Object.freeze(
      [...this.#commands.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((command) => toSpec(command)),
    );
    return this.#specs;
  }

  /** Checks an invocation without running it. Side-effect free, like a tool's. */
  public check(invocation: CommandInvocation): CommandCheck {
    const command = this.#commands.get(invocation.command);
    if (command === undefined) return { rejection: { reason: 'unknownCommand' } };

    const parsed = command.parameters.safeParse(invocation.arguments ?? {});
    if (!parsed.success) {
      return {
        rejection: { detail: z.prettifyError(parsed.error), reason: 'invalidArguments' },
      };
    }

    return { args: parsed.data, command };
  }
}

function toSpec(command: BrokerCommand): BrokerCommandSpec {
  return Object.freeze({
    description: command.description,
    name: command.name,
    // `input`, because a transport is drawing what someone is about to fill in:
    // a defaulted field is one they may leave alone, not one that is always there.
    parameters: z.toJSONSchema(command.parameters, { io: 'input' }) as JsonSchema,
  });
}

export { brokerCommand, BUILTIN_COMMANDS, CommandCatalog, stopCommand };

export type { BrokerCommand, CommandCheck, CommandContext };
