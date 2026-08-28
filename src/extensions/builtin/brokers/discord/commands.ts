import type { DiscordCommand, DiscordCommandOption } from './rest';
import type { BrokerCommandSpec, JsonSchema } from '@nox/extension-api';

/** Discord's application command option types, for the scalars Nox can express. */
const OPTION_STRING = 3;
const OPTION_INTEGER = 4;
const OPTION_BOOLEAN = 5;
const OPTION_NUMBER = 10;

/**
 * Where a published command may be invoked.
 *
 * These only mean anything on the global list: a guild command list belongs to
 * one server and is never offered anywhere else, which is why a direct message
 * has no commands at all until they are published globally. `PRIVATE_CHANNEL` —
 * a group DM the bot is not in — is deliberately absent: it needs the
 * application to be user-installable, and this bot is installed to servers.
 */
const CONTEXT_GUILD = 0;
const CONTEXT_BOT_DM = 1;

/** Commands come from the bot's presence in a server, not from a user install. */
const INTEGRATION_GUILD_INSTALL = 0;

const MAX_OPTIONS = 25;
const MAX_CHOICES = 25;
const MAX_DESCRIPTION = 100;
const NAME_PATTERN = /^[-_\p{L}\p{N}]{1,32}$/u;

/**
 * Why a command Nox offers is not published as a slash command.
 *
 * Every one of these is a real limit of Discord's command grammar, not a
 * shortcoming of the declaration. A command catalog is deliberately as
 * expressive as a tool's parameters — nested objects, lists, unions — and
 * Discord's options are flat scalars with optional choices.
 */
type CommandSkip =
  | { readonly detail: string; readonly reason: 'unsupportedParameter' }
  | { readonly reason: 'notAnObject' }
  | { readonly reason: 'tooManyOptions' }
  | { readonly reason: 'unusableName' };

type CommandMapping = { readonly command: DiscordCommand } | { readonly skip: CommandSkip };

function typeOf(schema: JsonSchema): string | undefined {
  if (typeof schema.type === 'string') return schema.type;
  // A nullable field arrives as ["string","null"]; the payload type is the one
  // that is not null, and optionality is already carried by `required`.
  if (Array.isArray(schema.type)) return schema.type.find((entry) => entry !== 'null');
  return undefined;
}

/**
 * Discord shows a description under every option and refuses an empty one, so a
 * parameter that documented itself gets its own words and one that did not gets
 * its name. Truncated rather than rejected: losing the tail of a long
 * description is not a reason to withhold a working command.
 */
function describe(schema: JsonSchema, fallback: string): string {
  const text = schema.description?.trim();
  const chosen = text === undefined || text.length === 0 ? fallback : text;
  return chosen.length > MAX_DESCRIPTION ? `${chosen.slice(0, MAX_DESCRIPTION - 1)}…` : chosen;
}

/**
 * A closed set of values becomes a picker. Only strings and numbers, because
 * those are the only choice values Discord carries, and only up to its limit —
 * past that the field stays free text rather than becoming a truncated list that
 * silently omits valid answers.
 */
function choicesOf(schema: JsonSchema): DiscordCommandOption['choices'] {
  const values = schema.enum;
  if (values === undefined || values.length === 0 || values.length > MAX_CHOICES) return undefined;

  const usable = values.filter(
    (value): value is number | string => typeof value === 'string' || typeof value === 'number',
  );
  if (usable.length !== values.length) return undefined;

  return usable.map((value) => ({ name: String(value), value }));
}

function optionFor(
  name: string,
  schema: JsonSchema,
  required: boolean,
): CommandSkip | DiscordCommandOption {
  if (!NAME_PATTERN.test(name)) return { reason: 'unusableName' };

  const kind = typeOf(schema);
  const type =
    kind === 'string'
      ? OPTION_STRING
      : kind === 'integer'
        ? OPTION_INTEGER
        : kind === 'number'
          ? OPTION_NUMBER
          : kind === 'boolean'
            ? OPTION_BOOLEAN
            : undefined;

  if (type === undefined) {
    return {
      detail: `"${name}" is ${kind ?? 'an unnamed type'}, which Discord options cannot express.`,
      reason: 'unsupportedParameter',
    };
  }

  const choices = type === OPTION_BOOLEAN ? undefined : choicesOf(schema);
  return {
    ...(choices === undefined ? {} : { choices }),
    description: describe(schema, name),
    name: name.toLowerCase(),
    required,
    type,
  };
}

/**
 * One command as Discord can publish it, or why it cannot be.
 *
 * The mapping is derived from the declared schema and never from a list of
 * command names: the catalog grows, and a transport that hard-coded today's
 * commands would publish a stale palette the first time one is added.
 *
 * Where a command does not fit, it is left unpublished rather than degraded into
 * a single free-text field holding raw JSON. Asking a person in a chat to type
 * an object by hand is worse than not offering the command there; it remains
 * available on every surface that can draw the real form.
 *
 * A global command says where it may be used and a guild one does not, because
 * for a guild command there is nothing to say: it exists in exactly one server.
 */
function toDiscordCommand(spec: BrokerCommandSpec, global = false): CommandMapping {
  if (!NAME_PATTERN.test(spec.name)) return { skip: { reason: 'unusableName' } };

  const schema = spec.parameters;
  if (typeOf(schema) !== 'object' && schema.properties === undefined) {
    return { skip: { reason: 'notAnObject' } };
  }

  const properties = Object.entries(schema.properties ?? {});
  if (properties.length > MAX_OPTIONS) return { skip: { reason: 'tooManyOptions' } };

  const required = new Set(schema.required ?? []);
  const options: DiscordCommandOption[] = [];
  for (const [name, property] of properties) {
    const option = optionFor(name, property, required.has(name));
    if ('reason' in option) return { skip: option };
    options.push(option);
  }

  return {
    command: {
      ...(global
        ? {
            contexts: [CONTEXT_GUILD, CONTEXT_BOT_DM],
            integration_types: [INTEGRATION_GUILD_INSTALL],
          }
        : {}),
      description: describe({ description: spec.description }, spec.name),
      name: spec.name.toLowerCase(),
      // Discord refuses a list where an optional option precedes a required one.
      options: [...options].sort((left, right) => Number(right.required) - Number(left.required)),
    },
  };
}

/** One interaction option as Discord sends it back. */
interface InteractionOption {
  readonly name: string;
  readonly value?: unknown;
}

/**
 * The arguments a person filled in, as the catalog will check them.
 *
 * Nothing is coerced or defaulted here. The command's own schema is the one
 * declaration an invocation is validated against, and a transport that quietly
 * repaired what it collected would be enforcing a second, private version of it.
 */
function commandArguments(
  options: readonly InteractionOption[] | undefined,
): Record<string, unknown> {
  const collected: Record<string, unknown> = {};
  for (const option of options ?? []) {
    if (option.value !== undefined) collected[option.name] = option.value;
  }
  return collected;
}

export {
  commandArguments,
  CONTEXT_BOT_DM,
  CONTEXT_GUILD,
  INTEGRATION_GUILD_INSTALL,
  MAX_CHOICES,
  MAX_OPTIONS,
  OPTION_BOOLEAN,
  OPTION_INTEGER,
  OPTION_NUMBER,
  OPTION_STRING,
  toDiscordCommand,
};

export type { CommandMapping, CommandSkip, InteractionOption };
