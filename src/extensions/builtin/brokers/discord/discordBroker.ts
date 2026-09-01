import { toMessageContent, toUploads } from './attachments';
import { commandArguments, toDiscordCommand } from './commands';
import { ROLE_PREFIX } from './config';
import { admitsCommand, decideIngress } from './ingress';
import { chunkMessage } from './render';
import { DiscordRest, EPHEMERAL, INTERACTION_REPLY, INTERACTION_UPDATE_MESSAGE } from './rest';
import { DiscordSocket } from './socket';

import type { DiscordBrokerRuntimeConfig, DiscordChannelPolicy } from './config';
import type { IngressMessage, IngressPolicy } from './ingress';
import type {
  DiscordActionRow,
  DiscordCommand,
  DiscordMessagePayload,
  DiscordUpload,
} from './rest';
import type {
  ArtifactPipeline,
  Broker,
  BrokerCapabilities,
  BrokerHost,
  Logger,
  MessageContent,
  OutboundEvent,
  PermissionRequest,
} from '@nox/extension-api';

/** Discord's interaction kinds this transport answers. */
const INTERACTION_APPLICATION_COMMAND = 2;
const INTERACTION_MESSAGE_COMPONENT = 3;

/** Prefix on every button this broker owns, so a stray click is recognisable. */
const PERMISSION_PREFIX = 'nox:perm';

/** How many files Discord will take on one message. */
const MAX_FILES_PER_MESSAGE = 10;

/**
 * How often the typing indicator is renewed. Discord's own lapses after about
 * ten seconds, so a run that takes longer than one has to keep saying so.
 */
const TYPING_INTERVAL_MS = 8_000;

/**
 * How long after posting before the indicator goes back up.
 * Discord clears it whenever the bot speaks; waiting a beat lets `runCompleted` —
 * which lands within milliseconds — decide whether the run is actually over.
 */
const TYPING_RESUME_MS = 1_000;

interface DiscordBrokerOptions {
  readonly logger: Logger;
  /** Where files posted into a channel are stored. Absent leaves text only. */
  readonly pipeline?: ArtifactPipeline;
}

/** A permission prompt that is posted and waiting, and who may answer it. */
interface PostedPermission {
  readonly channelId: string;
  readonly messageId: string;
  /** The sender ID of the principal whose run raised the request. */
  readonly ownerId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Every command scope that must be empty once one selected scope is published.
 * Discord keeps global and per-guild commands as independent catalogs; replacing
 * one leaves the rest untouched, so an uncleared scope makes a command appear twice.
 */
function staleCommandScopes(
  selectedGuildId: string | undefined,
  connectedGuildIds: readonly string[],
): readonly (string | undefined)[] {
  const scopes = new Set<string | undefined>([undefined, ...connectedGuildIds]);
  scopes.delete(selectedGuildId);
  return [...scopes];
}

/**
 * What to call this person, most specific first: guild nickname, display name,
 * account name. Presentation only — a display name is not unique and changes at
 * its owner's whim, which is exactly why the ID stays the subject.
 */
function displayNameOf(
  author: Record<string, unknown>,
  member: Record<string, unknown> | undefined,
): string | undefined {
  const candidates = [member?.nick, author.global_name, author.username];
  for (const candidate of candidates) {
    const name = asString(candidate)?.trim();
    if (name !== undefined && name.length > 0) return name;
  }
  return undefined;
}

/**
 * When Discord says the message was sent. Kept rather than stamped on arrival:
 * the two are the same for live traffic and they are not for anything read back,
 * and a transcript that says otherwise is wrong about when people spoke.
 */
function timestampOf(value: unknown): Date | undefined {
  const text = asString(value);
  if (text === undefined) return undefined;

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * The three answers a prompt offers. `session` is deliberately the middle
 * button rather than the first: approving once is the reading a person should
 * fall into when they are half paying attention.
 */
function permissionButtons(requestId: string, disabled = false): readonly DiscordActionRow[] {
  return [
    {
      components: [
        {
          custom_id: `${PERMISSION_PREFIX}:${requestId}:once`,
          disabled,
          label: 'Approve once',
          style: 3,
          type: 2,
        },
        {
          custom_id: `${PERMISSION_PREFIX}:${requestId}:session`,
          disabled,
          label: 'Approve for the session',
          style: 1,
          type: 2,
        },
        {
          custom_id: `${PERMISSION_PREFIX}:${requestId}:deny`,
          disabled,
          label: 'Deny',
          style: 4,
          type: 2,
        },
      ],
      type: 1,
    },
  ];
}

/**
 * What a person needs in order to answer, and nothing that only means something
 * inside Nox. The owner is mentioned rather than named, so everyone else in the
 * channel can see that it is not them.
 */
function permissionText(request: PermissionRequest, ownerId: string): string {
  const lines = [
    `<@${ownerId}> **${request.title}**`,
    request.reason,
    `\`${request.toolSetId}/${request.toolName}\` · authority \`${request.authority}\``,
  ];
  if (request.preview !== undefined && request.preview.length > 0) {
    lines.push('```', request.preview.slice(0, 800), '```');
  }
  for (const signal of request.signals) {
    if (signal.severity === 'info') continue;
    lines.push(`- ${signal.severity}: ${signal.reason}`);
  }
  return lines.join('\n');
}

/**
 * Nox on Discord: delivers what arrived and renders what it is handed, and knows
 * nothing about agents, sessions or the transcript. Two things about this
 * transport shape everything here: a channel is a room (admission and authority
 * in it are separate decisions), and a room has more than one person in it (as
 * soon as a second principal speaks the session is shared for good, effectful
 * calls need their originator's explicit approval, and session-scoped approvals
 * stop applying). That is why `permissions` is declared unconditionally.
 */
class DiscordBroker implements Broker {
  public readonly capabilities: BrokerCapabilities;

  readonly #channels: ReadonlyMap<string, DiscordChannelPolicy>;
  readonly #config: DiscordBrokerRuntimeConfig;
  readonly #logger: Logger;
  /** Prompts posted and still waiting, by request ID. */
  readonly #posted = new Map<string, PostedPermission>();
  readonly #pipeline?: ArtifactPipeline;
  /**
   * The roles each member holds, as the gateway last reported them. A cache
   * rather than a lookup: Discord sends role IDs with every message and
   * `GUILD_MEMBER_UPDATE` corrects them, while a REST call per authorization
   * would make a rate limit into a denial. Absent grants nothing; a stale entry
   * can only ever withhold, never widen.
   */
  readonly #roles = new Map<string, readonly string[]>();
  /** Conversations with a run in flight, so speech can join it instead of queueing. */
  readonly #running = new Set<string>();
  /** The renewal loop keeping the typing indicator up, by channel. */
  readonly #typing = new Map<string, ReturnType<typeof setInterval>>();
  /** Indicators waiting to go back up after the bot spoke, by channel. */
  readonly #typingResume = new Map<string, ReturnType<typeof setTimeout>>();

  #host?: BrokerHost;
  #policy?: IngressPolicy;
  #rest?: DiscordRest;
  #socket?: DiscordSocket;

  constructor(config: DiscordBrokerRuntimeConfig, options: DiscordBrokerOptions) {
    this.#config = config;
    this.#logger = options.logger;
    if (options.pipeline !== undefined) this.#pipeline = options.pipeline;
    this.#channels = new Map(Object.entries(config.channels));
    this.capabilities = Object.freeze({
      commands: true,
      permissions: true,
      reasoning: config.verbose.reasoning,
      // Always asked for: run boundaries decide whether the agent is mid-thought,
      // which is what chooses between speaking to it and speaking over it.
      // `verbose.runs` decides what the channel sees.
      runs: true,
      toolActivity: config.verbose.toolActivity,
      usage: config.verbose.usage,
    });
  }

  /**
   * Connects, learns who the bot is, and publishes the command catalog.
   *
   * The first connection is awaited: a broker that reported itself started while
   * it was still failing to log in would leave a Nox believing it is reachable
   * on a channel it never joined. A drop after that is weather, and the socket
   * handles it.
   */
  public async start(host: BrokerHost): Promise<void> {
    this.#host = host;
    this.#rest = new DiscordRest({
      logger: host.logger,
      signal: host.signal,
      token: this.#config.token,
    });

    const socket = new DiscordSocket({
      logger: host.logger,
      onDispatch: (type, data) => {
        this.#onDispatch(type, data);
      },
      signal: host.signal,
      token: this.#config.token,
    });
    this.#socket = socket;

    const identity = await socket.connect();
    this.#policy = {
      channels: this.#channels,
      dms: new Set(this.#config.dms),
      // The bot's own username always counts, so nobody has to configure the
      // name Discord already gave it.
      names: [...this.#config.names, identity.username]
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name.length > 0),
      selfId: identity.id,
    };

    await this.#publishCommands(host, identity.guildIds);
  }

  /**
   * Lets go of Discord. Called on shutdown and on every reconfiguration, since
   * broker settings apply hot: this instance is replaced by a new one, so the
   * socket has to actually close rather than keep reconnecting underneath.
   */
  public stop(): Promise<void> {
    this.#socket?.close();
    this.#socket = undefined;
    this.#posted.clear();
    this.#roles.clear();
    this.#running.clear();
    for (const channelId of [...this.#typing.keys()]) this.#stopTyping(channelId);
    this.#host = undefined;
    this.#policy = undefined;
    return Promise.resolve();
  }

  /**
   * Whether Discord will take a message addressed to this channel.
   *
   * Answered against Discord rather than against `channels`, because that list
   * is the guild channels this broker *reads*: a direct message is reachable,
   * belongs in no guild, and is exactly the address a schedule is most often
   * pointed at, so checking against configuration would refuse the common case
   * and accept a stale guild ID. A broker that is not connected declines to
   * answer instead of guessing, which leaves the address unchecked rather than
   * condemned.
   */
  public async canDeliverTo(channelId: string, signal: AbortSignal): Promise<boolean> {
    const rest = this.#rest;
    if (rest === undefined) throw new Error('Discord is not connected.');
    signal.throwIfAborted();
    return rest.canReach(channelId);
  }

  /** Renders one event into the channel it belongs to. */
  public async deliver(event: OutboundEvent): Promise<void> {
    const rest = this.#rest;
    if (rest === undefined) return;

    switch (event.type) {
      case 'commandResult':
        this.#assertPosted(
          event.conversationId,
          await this.#post(
            event.conversationId,
            `${event.status === 'failed' ? '⚠️' : '✓'} /${event.name}: ${event.text}`,
          ),
        );
        break;
      case 'error':
        this.#assertPosted(
          event.conversationId,
          await this.#post(event.conversationId, `⚠️ ${event.text}`),
        );
        break;
      case 'message':
        this.#assertPosted(
          event.conversationId,
          await this.#post(event.conversationId, event.text, event.content),
        );
        break;
      case 'permission':
        await this.#postPermission(event.conversationId, event.request);
        break;
      case 'permissionResolved':
        await this.#retractPermission(event.requestId, event.resolution.resolution);
        break;
      case 'reasoning':
        await this.#post(event.conversationId, `-# 💭 ${event.text}`);
        break;
      case 'runCompleted':
        this.#running.delete(event.conversationId);
        this.#stopTyping(event.conversationId);
        if (this.#config.verbose.runs && event.status !== 'completed') {
          await this.#post(event.conversationId, `-# run ${event.status}`);
        }
        break;
      case 'runStarted':
        this.#running.add(event.conversationId);
        this.#startTyping(event.conversationId);
        break;
      case 'toolCall':
        await this.#post(event.conversationId, `-# 🔧 \`${event.name}\``);
        break;
      case 'toolResponse':
        if (event.isError) {
          await this.#post(event.conversationId, `-# 🔧 \`${event.name}\` failed`);
        }
        break;
      case 'usage':
        await this.#post(
          event.conversationId,
          `-# ${String(event.usage.inputTokens)} in · ${String(event.usage.outputTokens)} out`,
        );
        break;
      // Named rather than defaulted: each of these is either something a chat has
      // nowhere to put, or something already said another way.
      case 'contextChange':
      case 'contextUsage':
      case 'fragment':
      case 'reasoningFragment':
      case 'retry':
      case 'title':
        break;
    }
  }

  /**
   * The roles this member holds, as grant keys.
   *
   * Called by the host once per authorization, so what it returns is whatever
   * the gateway last said — which is the point: a role removed a moment ago
   * stops granting on the next tool call rather than at the end of the session.
   */
  public principalGroups(subject: string): readonly string[] {
    const roles = this.#roles.get(subject);
    if (roles === undefined) return [];
    return roles.map((roleId) => `${ROLE_PREFIX}${roleId}`);
  }

  /** Records what the gateway just told us about who holds what. */
  #rememberRoles(userId: string | undefined, roles: unknown): void {
    if (userId === undefined || userId.length === 0 || !Array.isArray(roles)) return;
    this.#roles.set(userId, Object.freeze(roles.filter((role) => typeof role === 'string')));
  }

  /**
   * Publishes the command catalog as slash commands, derived from what the host
   * declares rather than from any list kept here; a command Discord cannot
   * express is left unpublished and logged.
   *
   * Configuring no server publishes globally — the only way a bot in several
   * servers, or one talked to in DMs, has commands anywhere but one server.
   * Discord does not replace across scopes, so once the selected catalog is
   * safely present every other reachable scope is emptied; publishing first
   * avoids turning a cleanup failure into an application with no commands.
   */
  async #publishCommands(host: BrokerHost, connectedGuildIds: readonly string[]): Promise<void> {
    const rest = this.#rest;
    if (rest === undefined) return;

    const guildId = this.#config.guildId;
    const publishable: DiscordCommand[] = [];
    for (const spec of host.commands) {
      const mapping = toDiscordCommand(spec, guildId === undefined);
      if ('skip' in mapping) {
        host.logger.warn(
          { command: spec.name, reason: mapping.skip.reason },
          'Not publishing a command as a Discord slash command.',
        );
        continue;
      }
      publishable.push(mapping.command);
    }

    try {
      await rest.publishCommands(this.#config.applicationId, guildId, publishable);
      host.logger.info(
        { count: publishable.length, scope: guildId ?? 'global' },
        'Published Discord slash commands.',
      );
    } catch (error) {
      // Commands are a convenience over a conversation that works without them.
      // Failing to publish them is worth reporting, never worth refusing to run.
      host.logger.error({ err: error }, 'Could not publish Discord slash commands.');
      return;
    }

    for (const staleGuildId of staleCommandScopes(guildId, connectedGuildIds)) {
      try {
        await rest.publishCommands(this.#config.applicationId, staleGuildId, []);
        host.logger.debug(
          { scope: staleGuildId ?? 'global' },
          'Cleared stale Discord slash commands.',
        );
      } catch (error) {
        host.logger.error(
          { err: error, scope: staleGuildId ?? 'global' },
          'Could not clear stale Discord slash commands.',
        );
      }
    }
  }

  #onDispatch(type: string, data: Record<string, unknown>): void {
    switch (type) {
      case 'GUILD_MEMBER_ADD':
      case 'GUILD_MEMBER_UPDATE':
        this.#rememberRoles(isRecord(data.user) ? asString(data.user.id) : undefined, data.roles);
        break;
      case 'GUILD_MEMBER_REMOVE':
        // Someone who left holds nothing. Forgetting is the whole point: a
        // cached role list outliving the membership would keep granting.
        if (isRecord(data.user)) {
          const userId = asString(data.user.id);
          if (userId !== undefined) this.#roles.delete(userId);
        }
        break;
      case 'INTERACTION_CREATE':
        void this.#onInteraction(data);
        break;
      case 'MESSAGE_CREATE':
        void this.#onMessage(data);
        break;
      default:
        break;
    }
  }

  /** One message that arrived, put through the ingress rule and nothing else. */
  async #onMessage(data: Record<string, unknown>): Promise<void> {
    const host = this.#host;
    const policy = this.#policy;
    if (host === undefined || policy === undefined) return;

    const author = isRecord(data.author) ? data.author : {};
    const member = isRecord(data.member) ? data.member : undefined;
    const referenced = isRecord(data.referenced_message) ? data.referenced_message : undefined;
    const referencedAuthor = isRecord(referenced?.author) ? referenced.author : {};
    const mentions = Array.isArray(data.mentions) ? data.mentions : [];
    const channelId = asString(data.channel_id) ?? '';
    const messageId = asString(data.id) ?? '';
    const content = asString(data.content) ?? '';
    const authorId = asString(author.id) ?? '';

    // Recorded before the ingress rule runs, for every message including the
    // ones it refuses: role facts do not depend on whether a message was admitted.
    this.#rememberRoles(authorId, member?.roles);

    const message: IngressMessage = {
      authorId,
      authorIsBot: author.bot === true,
      authorRoles: this.#roles.get(authorId) ?? [],
      channelId,
      content,
      ...(asString(data.guild_id) === undefined ? {} : { guildId: asString(data.guild_id) }),
      mentionsSelf: mentions.some(
        (mention) => isRecord(mention) && asString(mention.id) === policy.selfId,
      ),
      ...(asString(data.thread_parent_id) === undefined
        ? {}
        : { parentChannelId: asString(data.thread_parent_id) }),
      repliedToSelf: asString(referencedAuthor.id) === policy.selfId,
      viaWebhook: data.webhook_id !== undefined,
    };

    const decision = decideIngress(message, policy);
    if (decision.kind === 'ignore') {
      host.logger.trace(
        { channelId, messageId, reason: decision.reason },
        'Discord message not admitted.',
      );
      return;
    }

    // Files come in as durable references Nox owns, never as remote URLs that
    // expire. An observation carries them too: what was posted in the room is
    // part of what was said there.
    const parts = await toMessageContent(content, data.attachments, {
      logger: host.logger,
      pipeline: this.#pipeline,
      scope: host.artifactScope(channelId),
      signal: host.signal,
    });
    if (parts.length === 0) return;

    const said = timestampOf(data.timestamp);
    const name = displayNameOf(author, member);

    if (decision.kind === 'observe') {
      void host.receive({
        content: parts,
        conversationId: channelId,
        messageId,
        senderId: message.authorId,
        ...(name === undefined ? {} : { senderName: name }),
        ...(said === undefined ? {} : { receivedAt: said }),
        type: 'observation',
      });
      return;
    }

    // Speaking mid-thought steers the run at its next safe opening; speaking to
    // an idle one is an ordinary message. Same words, only the moment differs.
    const type = this.#running.has(channelId) ? 'steer' : 'message';
    const rejection = await host.receive({
      content: parts,
      conversationId: channelId,
      messageId,
      senderId: message.authorId,
      ...(name === undefined ? {} : { senderName: name }),
      ...(said === undefined ? {} : { receivedAt: said }),
      type,
    });

    if (rejection !== undefined) {
      await this.#post(channelId, `⚠️ Nox cannot take that right now (${rejection.reason}).`);
      return;
    }

    // The room is told something is happening before any run has started: the gap
    // a model call opens is exactly the gap this covers; `runStarted` takes over.
    this.#poke(channelId);
  }

  /**
   * Keeps the typing indicator up for as long as the run lasts.
   *
   * Discord's indicator lapses after about ten seconds and is cleared outright
   * whenever the bot posts, so one call at the start of a run only ever covers
   * the first answer. The run boundary is the honest thing to tie it to: the
   * channel sees "typing" for precisely as long as Nox is working on a reply,
   * across however many messages, tool calls and silences that takes. This is why
   * `runs` is asked for unconditionally in `capabilities`.
   */
  #startTyping(channelId: string): void {
    if (this.#typing.has(channelId)) return;

    this.#poke(channelId);
    this.#typing.set(
      channelId,
      setInterval(() => {
        this.#poke(channelId);
      }, TYPING_INTERVAL_MS),
    );
  }

  #stopTyping(channelId: string): void {
    const loop = this.#typing.get(channelId);
    if (loop !== undefined) {
      clearInterval(loop);
      this.#typing.delete(channelId);
    }

    const resume = this.#typingResume.get(channelId);
    if (resume === undefined) return;
    clearTimeout(resume);
    this.#typingResume.delete(channelId);
  }

  /**
   * Puts the indicator back after the bot has spoken, unless the run ended in the
   * meantime. Nothing can retract a typing indicator except posting again, so the
   * one that must not be sent is the one after the final message.
   */
  #resumeTyping(channelId: string): void {
    if (!this.#typing.has(channelId)) return;

    const pending = this.#typingResume.get(channelId);
    if (pending !== undefined) clearTimeout(pending);

    this.#typingResume.set(
      channelId,
      setTimeout(() => {
        this.#typingResume.delete(channelId);
        if (this.#typing.has(channelId)) this.#poke(channelId);
      }, TYPING_RESUME_MS),
    );
  }

  /**
   * One indicator, sent and forgotten. A channel that will not take it is not a
   * reason to fail a reply that is otherwise fine.
   */
  #poke(channelId: string): void {
    void this.#rest?.triggerTyping(channelId).catch(() => undefined);
  }

  async #onInteraction(data: Record<string, unknown>): Promise<void> {
    const interactionId = asString(data.id);
    const token = asString(data.token);
    if (interactionId === undefined || token === undefined) return;

    // An interaction carries the member too, so pressing a button or invoking a
    // command keeps the role cache as current as speaking does.
    const member = isRecord(data.member) ? data.member : undefined;
    if (member !== undefined && isRecord(member.user)) {
      this.#rememberRoles(asString(member.user.id), member.roles);
    }

    if (data.type === INTERACTION_MESSAGE_COMPONENT) {
      await this.#onButton(interactionId, token, data);
      return;
    }
    if (data.type === INTERACTION_APPLICATION_COMMAND) {
      await this.#onSlashCommand(interactionId, token, data);
    }
  }

  /**
   * A button was pressed.
   *
   * Whether the person who pressed it may answer is checked here as well as in
   * the Gate, and that is not redundancy for its own sake: the request names its
   * owner, so this transport can tell everyone else privately that the decision
   * is not theirs instead of sending an event that is refused where nobody can
   * see it.
   */
  async #onButton(
    interactionId: string,
    token: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const payload = isRecord(data.data) ? data.data : {};
    const customId = asString(payload.custom_id) ?? '';
    if (!customId.startsWith(`${PERMISSION_PREFIX}:`)) return;

    const [, , requestId = '', action = ''] = customId.split(':');
    const member = isRecord(data.member) ? data.member : undefined;
    const user = isRecord(member?.user) ? member.user : isRecord(data.user) ? data.user : {};
    const senderId = asString(user.id) ?? '';
    const posted = this.#posted.get(requestId);

    if (posted === undefined) {
      await this.#ephemeral(interactionId, token, 'That request is no longer waiting.');
      return;
    }
    if (senderId !== posted.ownerId) {
      await this.#ephemeral(
        interactionId,
        token,
        'Only the person whose run raised this request can answer it.',
      );
      return;
    }

    // Acknowledged before anything else: Discord shows the person a failure if a
    // click is not answered within three seconds, and what happens next is
    // queued behind whatever else that conversation has going.
    await this.#rest
      ?.respondToInteraction(interactionId, token, {
        data: { components: permissionButtons(requestId, true) },
        type: INTERACTION_UPDATE_MESSAGE,
      })
      .catch((error: unknown) => {
        this.#logger.warn({ err: error }, 'Could not acknowledge a Discord button.');
      });

    void this.#host?.receive({
      conversationId: posted.channelId,
      requestId,
      resolution:
        action === 'deny' ? 'denied' : { approved: action === 'session' ? 'session' : 'once' },
      senderId,
      type: 'permission',
    });
  }

  /**
   * A slash command was invoked. Where it was typed is checked here and nowhere
   * else: a command published globally is offered in every server and DM the
   * bot can reach, while this broker reads a configured list of channels —
   * without this, publishing globally would make a command a way into Nox from
   * a room nobody admitted. The refusal is ephemeral: the person who typed it
   * learns it went nowhere, and the room is not told anything.
   *
   * Checking is synchronous and answers the only things a person can act on;
   * what the command then does with the conversation is queued like a message.
   */
  async #onSlashCommand(
    interactionId: string,
    token: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const host = this.#host;
    const policy = this.#policy;
    if (host === undefined || policy === undefined) return;

    const payload = isRecord(data.data) ? data.data : {};
    const member = isRecord(data.member) ? data.member : undefined;
    const user = isRecord(member?.user) ? member.user : isRecord(data.user) ? data.user : {};
    const channel = isRecord(data.channel) ? data.channel : undefined;
    const channelId = asString(data.channel_id) ?? '';
    const senderId = asString(user.id) ?? '';
    const options = Array.isArray(payload.options)
      ? payload.options.filter(isRecord).map((option) => ({
          name: asString(option.name) ?? '',
          value: option.value,
        }))
      : [];

    const refusal = admitsCommand(
      {
        channelId,
        ...(asString(data.guild_id) === undefined ? {} : { guildId: asString(data.guild_id) }),
        ...(asString(channel?.parent_id) === undefined
          ? {}
          : { parentChannelId: asString(channel?.parent_id) }),
        senderId,
        senderRoles: this.#roles.get(senderId) ?? [],
      },
      policy,
    );
    if (refusal !== undefined) {
      host.logger.trace({ channelId, reason: refusal, senderId }, 'Discord command not admitted.');
      await this.#ephemeral(interactionId, token, 'Nox does not answer here.');
      return;
    }

    const rejection = await host.command({
      arguments: commandArguments(options),
      command: asString(payload.name) ?? '',
      conversationId: channelId,
      senderId,
    });

    const answer =
      rejection === undefined
        ? 'Accepted.'
        : rejection.reason === 'invalidArguments'
          ? `That does not fit: ${rejection.detail}`
          : rejection.reason === 'unknownCommand'
            ? 'Nox does not have that command.'
            : 'Nox cannot take that right now.';

    await this.#ephemeral(interactionId, token, answer);
  }

  async #postPermission(conversationId: string, request: PermissionRequest): Promise<void> {
    const ownerId = request.runAuthority.principal.subject;
    try {
      const messageId = await this.#rest?.createMessage(conversationId, {
        components: permissionButtons(request.requestId),
        content: permissionText(request, ownerId),
      });
      if (messageId === undefined) return;
      this.#posted.set(request.requestId, { channelId: conversationId, messageId, ownerId });
    } catch (error) {
      this.#logger.error({ err: error }, 'Could not post a permission request to Discord.');
    }
  }

  /**
   * A permission is over, however it ended — answered here, answered on another
   * surface, timed out, or the run was aborted. The prompt is rewritten rather
   * than left behind: a dead set of buttons in a channel is an invitation to
   * press something that does nothing.
   */
  async #retractPermission(requestId: string, resolution: string): Promise<void> {
    const posted = this.#posted.get(requestId);
    if (posted === undefined) return;
    this.#posted.delete(requestId);

    try {
      await this.#rest?.editMessage(posted.channelId, posted.messageId, {
        components: permissionButtons(requestId, true),
        content: `-# This request was ${resolution}.`,
      });
    } catch (error) {
      this.#logger.warn({ err: error }, 'Could not retract a Discord permission prompt.');
    }
  }

  async #ephemeral(interactionId: string, token: string, content: string): Promise<void> {
    try {
      await this.#rest?.respondToInteraction(interactionId, token, {
        data: { content, flags: EPHEMERAL },
        type: INTERACTION_REPLY,
      });
    } catch (error) {
      this.#logger.warn({ err: error }, 'Could not answer a Discord interaction.');
    }
  }

  /**
   * One reply, as however many messages Discord will accept it in, followed by
   * the files it came with.
   *
   * Text and artifacts are separate messages rather than one, because the text
   * is chunked and the files are not: attaching them to a chunk would make which
   * message carries a file depend on how long the reply happened to be.
   */
  async #post(
    channelId: string,
    text: string,
    content: readonly MessageContent[] = [],
  ): Promise<boolean> {
    const rest = this.#rest;
    if (rest === undefined) return false;

    let delivered = true;
    for (const chunk of chunkMessage(text)) {
      if (!(await this.#send(channelId, { content: chunk }))) {
        delivered = false;
        break;
      }
    }

    if (delivered) await this.#postArtifacts(channelId, content);
    this.#resumeTyping(channelId);
    return delivered;
  }

  /**
   * The artifacts on one message, as the files themselves.
   *
   * An artifact that cannot be posted is named rather than dropped: the text of a
   * reply says nothing about the parts of it that were not text, so a file that
   * silently never arrives leaves the channel reading an answer about something
   * it cannot see.
   */
  async #postArtifacts(channelId: string, content: readonly MessageContent[]): Promise<void> {
    const host = this.#host;
    if (host === undefined || !content.some((part) => part.type === 'artifact')) return;

    const { missed, uploads } = await toUploads(content, {
      logger: this.#logger,
      pipeline: this.#pipeline,
      scope: host.artifactScope(channelId),
      signal: host.signal,
    });

    for (let from = 0; from < uploads.length; from += MAX_FILES_PER_MESSAGE) {
      const batch = uploads.slice(from, from + MAX_FILES_PER_MESSAGE);
      // A file Discord itself refuses — over this guild's own limit, or a type it
      // will not take — is reported like one that could not be read at all.
      if (!(await this.#send(channelId, {}, batch))) {
        await this.#send(channelId, {
          content: `-# ⚠️ Could not post: ${batch.map((upload) => upload.filename).join(', ')}`,
        });
      }
    }

    if (missed.length === 0) return;
    await this.#send(channelId, { content: `-# ⚠️ Could not post: ${missed.join(', ')}` });
  }

  /**
   * Turns a refused post into a thrown failure, for the events that *are* the
   * reply rather than commentary on it.
   *
   * The log line `#send` already wrote says what went wrong and is what an
   * operator reads; this is what a caller with no eyes on the channel gets, so
   * it names the address instead of repeating the cause. Discord's own reason
   * is one line above it in the log.
   */
  #assertPosted(channelId: string, delivered: boolean): void {
    if (delivered) return;
    throw new Error(`Discord refused a message addressed to channel "${channelId}".`);
  }

  /** One message, and whether it arrived. */
  async #send(
    channelId: string,
    payload: DiscordMessagePayload,
    uploads: readonly DiscordUpload[] = [],
  ): Promise<boolean> {
    try {
      await this.#rest?.createMessage(channelId, payload, uploads);
      return true;
    } catch (error) {
      this.#logger.error({ channelId, err: error }, 'Could not post a message to Discord.');
      return false;
    }
  }
}

export { DiscordBroker, permissionButtons, permissionText, staleCommandScopes };
