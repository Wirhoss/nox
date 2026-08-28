import {
  brokerBaseConfigSchema,
  brokerConversationsSchemaOf,
  brokerGrantsSchemaOf,
  runtimeSecretSchema,
  secretRefSchema,
  z,
} from '@nox/extension-api';

/**
 * A Discord snowflake. Validated rather than accepted as any string because
 * every ID in this file is pasted by a human out of a client, and a mistyped
 * channel is otherwise a broker that silently listens to nothing.
 */
const snowflakeSchema = z
  .string()
  .trim()
  .regex(/^\d{17,20}$/, 'Use a Discord ID: 17 to 20 digits, copied with Developer Mode on.');

/** The `role:` form of a Discord role ID, as grants and `senders` accept it. */
const ROLE_PREFIX = 'role:';

/**
 * Who an entry speaks for: one member, or everyone holding one role.
 *
 * Both halves of Discord's world are snowflakes and nothing in the ID says which
 * kind it is, so the prefix is what distinguishes them. Without it a role pasted
 * where a user was expected is a grant that quietly matches nobody, which is the
 * failure this whole file is written to avoid.
 */
const discordPrincipalRefSchema = z
  .string()
  .trim()
  .regex(
    /^(role:)?\d{17,20}$/,
    'Use a Discord user ID, or a role as "role:<id>": 17 to 20 digits, copied with Developer Mode on.',
  );

/** Whether a configured principal reference names a role rather than a member. */
function isRoleRef(reference: string): boolean {
  return reference.startsWith(ROLE_PREFIX);
}

/**
 * What makes a message in a guild channel something said *to* Nox.
 *
 * All four are deterministic on purpose, and they are the whole of the rule for
 * now. `all` is the honest name for "this channel exists for the bot": every
 * message in it is addressed, which is what a dedicated channel or a thread the
 * bot was invited into actually means.
 *
 * A non-deterministic gate — the bot reading the room and deciding whether it
 * has anything to say — is a later layer, and it sits *after* this one rather
 * than replacing it: it needs the unaddressed traffic to read, which is what
 * `observe` collects.
 */
const discordTriggerSchema = z.enum(['all', 'mention', 'name', 'reply']);

/**
 * What the agent is told about a channel it was not addressed in.
 *
 * `none` means the transcript contains only what was said to Nox, with the rest
 * of the room missing — which reads, to the model, as its own replies separated
 * by silence.
 *
 * `channel` is the truthful one and it is not free. Unaddressed traffic costs
 * context and gets folded and compacted like anything else, and — because a
 * second principal's words enter the transcript — it puts the session into the
 * shared-conversation floor permanently: every effectful tool call needs the
 * originator's explicit approval, and session-scoped approvals stop applying.
 * That is the correct consequence, not an accident, which is why the default is
 * `none` and turning it on is a deliberate act.
 */
const discordObserveSchema = z.enum(['channel', 'none']);

/**
 * One admitted guild channel.
 *
 * Admission and authority are separate decisions and stay in separate places: a
 * channel listed here is one Nox reads, and it grants nothing. Who may make the
 * agent *act* in it is `grants` and `conversations` on the broker itself, which
 * default to nobody.
 */
const discordChannelSchema = z.strictObject({
  observe: discordObserveSchema.prefault('none').meta({
    nox: { help: 'ui.observeHelp', label: 'ui.observe' },
  }),
  /**
   * Who may make the agent answer here. Empty means anyone the channel already
   * lets speak, which is Discord's own decision and a reasonable one for a
   * private team channel.
   *
   * It is a different question from `grants`, and both are worth having. Grants
   * decide what a principal may *do* once a run is theirs; this decides whether
   * a run starts at all. Without it, a channel opened to a wider audience turns
   * every passer-by into someone who can spend model calls, even with no
   * authority to reach a single tool.
   *
   * What a listed sender does not change is what an unlisted one costs: their
   * messages are still observed where the channel observes, because the room is
   * the room.
   */
  senders: z
    .array(discordPrincipalRefSchema)
    .readonly()
    .prefault([])
    .meta({ nox: { help: 'ui.sendersHelp', label: 'ui.senders' } }),
  respondTo: z
    .array(discordTriggerSchema)
    .min(1)
    .readonly()
    .prefault(['mention', 'reply'])
    .meta({ nox: { help: 'ui.respondToHelp', label: 'ui.respondTo' } }),
  /**
   * Whether threads under this channel are admitted with it. Inheriting is the
   * default because a thread is the natural unit of "one conversation with a
   * beginning and an end" on Discord — a thread is a channel, so it is its own
   * conversation with its own transcript — and needing to edit configuration
   * before the bot may answer in one would make that unusable.
   */
  threads: z
    .enum(['ignore', 'inherit'])
    .prefault('inherit')
    .meta({ nox: { help: 'ui.threadsHelp', label: 'ui.threads' } }),
});

/**
 * What of a run reaches the channel, beyond the reply itself.
 *
 * These become the broker's declared capabilities, so they decide what the
 * gateway sends *and* what a transcript read back through this transport
 * contains. Turning one off later does not hide what was already posted; it
 * hides that kind of thing from then on, in both directions.
 */
const discordVerbositySchema = z.strictObject({
  reasoning: z
    .boolean()
    .prefault(false)
    .meta({ nox: { help: 'ui.verboseReasoningHelp', label: 'ui.verboseReasoning' } }),
  runs: z
    .boolean()
    .prefault(false)
    .meta({ nox: { help: 'ui.verboseRunsHelp', label: 'ui.verboseRuns' } }),
  toolActivity: z
    .boolean()
    .prefault(false)
    .meta({ nox: { help: 'ui.verboseToolActivityHelp', label: 'ui.verboseToolActivity' } }),
  usage: z
    .boolean()
    .prefault(false)
    .meta({ nox: { help: 'ui.verboseUsageHelp', label: 'ui.verboseUsage' } }),
});

/**
 * The shape shared by the stored document and the resolved runtime value. Only
 * the credential differs between them: configuration holds a reference, and the
 * broker is handed an opaque handle.
 */
const discordConfigShape = {
  /**
   * The application the bot belongs to. Needed to register slash commands, which
   * are published against the application rather than the bot user.
   */
  applicationId: snowflakeSchema.meta({
    nox: { help: 'ui.applicationIdHelp', label: 'ui.applicationId' },
  }),
  /**
   * Admitted guild channels, keyed by channel ID. Empty means the bot reads no
   * channel at all — closed by default, exactly like `grants`.
   *
   * The keys are the same IDs `conversations` uses, because on Discord a
   * conversation *is* a channel. They are deliberately two records: this one
   * says what Nox listens to, that one says what may be done there.
   */
  channels: z
    .record(snowflakeSchema, discordChannelSchema)
    .prefault({})
    .meta({ nox: { help: 'ui.channelsHelp', label: 'ui.channels' } }),
  /**
   * Who may open a direct message with the bot, by user ID.
   *
   * A DM needs no ingress rule and does not get one: there is one person in it,
   * everything they say is addressed to Nox, and the session never becomes
   * shared. The only question a DM raises is admission, and this answers it once
   * rather than per message.
   *
   * The conversation ID of a DM is its channel ID, which Discord issues and
   * nobody can know in advance — so a `conversations` override for a DM can only
   * be written after the first one has been opened.
   */
  dms: z
    .array(snowflakeSchema)
    .readonly()
    .prefault([])
    .meta({ nox: { help: 'ui.dmsHelp', label: 'ui.dms' } }),
  /**
   * Where slash commands are published, or nothing to publish them globally.
   *
   * A guild registers them immediately, which is what an operator wants while
   * setting one up. Global is the other real case and not a worse one: a guild
   * command list belongs to a single server and cannot be used in a direct
   * message at all, so a bot that is in more than one server, or that is talked
   * to in DMs, needs its commands published globally. The cost is Discord's own —
   * about an hour to propagate — and it is the operator's call to make, not this
   * schema's.
   */
  guildId: snowflakeSchema
    .optional()
    .meta({ nox: { help: 'ui.guildIdHelp', label: 'ui.guildId' } }),
  /**
   * Extra words that count as being addressed where `respondTo` includes `name`.
   * The bot's own Discord username always counts and never needs listing; this
   * is for the name people actually use, which is rarely the account's.
   */
  names: z
    .array(z.string().trim().min(1).max(32))
    .readonly()
    .prefault([])
    .meta({ nox: { help: 'ui.namesHelp', label: 'ui.names' } }),
  verbose: discordVerbositySchema.prefault({}),
} as const;

/**
 * Configuration for the Discord transport, as `brokers.json` holds it.
 *
 * `agent`, `grants` and `conversations` come from the broker floor and mean the
 * same here as anywhere: `grants` is empty by default, and a per-conversation
 * override is what makes one channel a different security boundary from
 * another. That matters more on this transport than on any other, because a
 * single bot connection reaches every channel it can see with one issuer.
 */
const discordBrokerConfigSchema = brokerBaseConfigSchema.extend({
  ...discordConfigShape,
  // Narrowed from the broker floor's "any non-empty string" to Discord's own
  // vocabulary, so a mistyped ID fails at load beside the entry that named it.
  conversations: brokerConversationsSchemaOf(discordPrincipalRefSchema).prefault({}),
  grants: brokerGrantsSchemaOf(discordPrincipalRefSchema).prefault({}),
  token: secretRefSchema.meta({ nox: { help: 'ui.tokenHelp', label: 'ui.token' } }),
  type: z.literal('discord'),
});

/** The same configuration after the host has resolved the credential. */
const discordBrokerRuntimeConfigSchema = z.object({
  ...discordConfigShape,
  // Structural by design: a host capability must survive package boundaries.
  token: runtimeSecretSchema,
  type: z.literal('discord'),
});

type DiscordBrokerConfig = z.infer<typeof discordBrokerConfigSchema>;
type DiscordBrokerConfigInput = z.input<typeof discordBrokerConfigSchema>;
type DiscordBrokerRuntimeConfig = z.infer<typeof discordBrokerRuntimeConfigSchema>;
type DiscordBrokerRuntimeConfigInput = z.input<typeof discordBrokerRuntimeConfigSchema>;
type DiscordChannelPolicy = z.infer<typeof discordChannelSchema>;
type DiscordTrigger = z.infer<typeof discordTriggerSchema>;
type DiscordVerbosity = z.infer<typeof discordVerbositySchema>;

export {
  discordBrokerConfigSchema,
  discordBrokerRuntimeConfigSchema,
  discordChannelSchema,
  discordPrincipalRefSchema,
  discordTriggerSchema,
  isRoleRef,
  ROLE_PREFIX,
  snowflakeSchema,
};

export type {
  DiscordBrokerConfig,
  DiscordBrokerConfigInput,
  DiscordBrokerRuntimeConfig,
  DiscordBrokerRuntimeConfigInput,
  DiscordChannelPolicy,
  DiscordTrigger,
  DiscordVerbosity,
};
