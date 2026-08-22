import { z } from 'zod';

import type { Session } from '../agent/session';
import type { PrincipalRef } from '../auth/principal';
import type { Logger } from '../logger/logger';
import type { JsonSchema } from '../utils/jsonSchema';

/**
 * What a command is handed. One conversation, and who invoked it — never the
 * gateway: a command acts on the chat it was invoked in, and one that could
 * reach past it would be a way for a transport to touch another.
 */
interface CommandContext {
  /**
   * Ends this conversation's session. Not destruction: the binding survives, so
   * the next message reopens the same transcript rather than starting over.
   */
  close(): Promise<void>;
  readonly conversationId: string;
  readonly logger: Logger;
  /** The principal the transport authenticated, for attribution and audit. */
  readonly sender: PrincipalRef;
  readonly session: Session;
}

/**
 * Something a person does to a conversation, rather than something they say.
 *
 * Speech and commands are different things and the split is deliberate. A
 * message — including a steer — is attributed, deduplicated and appended to the
 * transcript, because it is what someone said. A command is not in the
 * transcript at all: it acts on the conversation, and the model never reads it.
 *
 * It is shaped like a tool on purpose. A name, a description and a zod schema is
 * already how this codebase describes a named operation with typed parameters to
 * a consumer that has to render it and may send it garbage; a command is that
 * same problem with a person on the other end instead of a model. Which means a
 * command with a list parameter, a multiple choice or a nested object costs
 * nothing extra: the schema is the whole declaration, and every surface derives
 * what it draws from it.
 */
interface BrokerCommand<T extends z.ZodObject = z.ZodObject> {
  readonly description: string;
  readonly name: string;
  readonly parameters: T;
  run(context: CommandContext, args: z.infer<T>): Promise<void>;
}

/** Preserves a command's parameter schema at its declaration site. */
function brokerCommand<T extends z.ZodObject>(definition: BrokerCommand<T>): BrokerCommand<T> {
  return definition;
}

/**
 * A command as a transport sees it: enough to draw a form, fill a palette or
 * register a slash command, and nothing that only means something inside Nox.
 * The schema is the same conversion a model is handed for a tool.
 */
interface BrokerCommandSpec {
  readonly description: string;
  readonly name: string;
  readonly parameters: JsonSchema;
}

/** One invocation, as a transport states it. */
interface CommandInvocation {
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly command: string;
  readonly conversationId: string;
  /** Who the transport authenticated. It asserts identity; it grants nothing. */
  readonly senderId: string;
}

/**
 * Why an invocation never reached the conversation. These are the refusals a
 * client can do something about — a command that does not exist, arguments that
 * do not fit, a Nox that is shutting down. What a command then does with a
 * conversation is not one of them: it is queued behind whatever else that chat
 * has going, exactly like a message, and reporting on it would mean holding a
 * request open across a run.
 */
type CommandRejection =
  | { readonly detail: string; readonly reason: 'invalidArguments' }
  | { readonly reason: 'unavailable' }
  | { readonly reason: 'unknownCommand' };

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
  run: async (context, { scope }): Promise<void> => {
    if (scope === 'session') {
      await context.close();
      return;
    }

    const aborted = await context.session.abort();
    context.logger.debug({ aborted }, 'Stopped the run in flight.');
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

export type {
  BrokerCommand,
  BrokerCommandSpec,
  CommandCheck,
  CommandContext,
  CommandInvocation,
  CommandRejection,
};
