import { createContributionPoint } from './core.js';

import type { PrincipalRef } from './content.js';
import type { ToolRisk } from './tools.js';
import type { z } from 'zod';

/** Runtime-owned accounting for the bounded context of the current session. */
interface CommandContextUsage {
  readonly compactAtTokens?: number;
  readonly contextWindow?: number;
  readonly usedTokens: number;
}

/** The conversation snapshot a command is acting on. */
interface CommandSessionInfo {
  readonly agentId: string;
  readonly contextUsage: CommandContextUsage;
  readonly modelId: string;
  readonly sessionId: string;
  readonly title?: string;
  readonly tools: readonly string[];
}

/** A model the current agent's configured provider can run. */
interface CommandModelInfo {
  readonly current: boolean;
  readonly modelId: string;
}

/** A command's visible result. It is never appended to model context. */
interface CommandResult {
  readonly text: string;
}

/**
 * The host operations available to a command.
 *
 * This deliberately does not expose Nox's Session, database, provider, or
 * gateway. A command can affect only the conversation in which it was invoked,
 * through operations whose lifecycle and persistence remain owned by the host.
 */
interface CommandContext {
  abort(): Promise<boolean>;
  close(): Promise<void>;
  compact(): Promise<{ readonly compacted: boolean; readonly reduced: boolean }>;
  readonly conversationId: string;
  info(): CommandSessionInfo;
  listAgents(): readonly string[];
  listCommands(): readonly { readonly description: string; readonly name: string }[];
  listModels(): readonly CommandModelInfo[];
  newSession(): Promise<CommandSessionInfo>;
  rename(title: string): Promise<void>;
  retry(): Promise<void>;
  readonly sender: PrincipalRef;
  switchAgent(agentId: string): Promise<CommandSessionInfo>;
  switchModel(modelId: string): Promise<CommandSessionInfo>;
}

/**
 * A person-facing operation contributed by an extension.
 *
 * Its contribution ID is its portable slash-command name: 1-32 lowercase ASCII
 * letters, digits, or hyphens, starting with a letter. Parameters are declared once
 * as Zod, rendered by transports as JSON Schema, and validated by the host before
 * `run` is called. Every extension command names an authority and concrete risk:
 * authorization is checked first and the session Gate evaluates the exact call.
 */
interface Command<T extends z.ZodObject = z.ZodObject> {
  readonly authority: string;
  readonly description: string;
  readonly parameters: T;
  risk(args: z.infer<T>): ToolRisk;
  run(context: CommandContext, args: z.infer<T>): Promise<CommandResult> | Promise<void>;
}

/** Preserves a command's parameter type at its declaration site. */
function defineCommand<T extends z.ZodObject>(definition: Command<T>): Command<T> {
  return Object.freeze({ ...definition });
}

const commands = createContributionPoint<Command>('nox.commands');

export { commands, defineCommand };

export type {
  Command,
  CommandContext,
  CommandContextUsage,
  CommandModelInfo,
  CommandResult,
  CommandSessionInfo,
};
