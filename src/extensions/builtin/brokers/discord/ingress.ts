import { isRoleRef, ROLE_PREFIX } from './config';

import type { DiscordChannelPolicy } from './config';

/**
 * One Discord message, reduced to the facts the rule is about. The broker
 * flattens a gateway payload into this before deciding anything, so the rule
 * itself is pure and can be tested without a socket or a fixture of Discord's
 * wire format.
 */
interface IngressMessage {
  readonly authorId: string;
  readonly authorIsBot: boolean;
  /**
   * The role IDs Discord reported for the author on this message. Present for
   * guild messages, empty for a direct message — which has no member and so no
   * roles, and is why DM admission stays a list of people.
   */
  readonly authorRoles: readonly string[];
  readonly channelId: string;
  readonly content: string;
  /** Absent in a direct message: Discord sends no guild for one. */
  readonly guildId?: string;
  /** Set when the channel is a thread; the channel it hangs from. */
  readonly parentChannelId?: string;
  /** The message is a reply to one Nox itself sent. */
  readonly repliedToSelf: boolean;
  /** Nox's own user or one of its roles is mentioned. */
  readonly mentionsSelf: boolean;
  /** Delivered by a webhook rather than by a user or an application. */
  readonly viaWebhook: boolean;
}

/**
 * What Nox does with a message that arrived. `address` is a turn: attributed to
 * its sender, it enters the transcript and starts a run under that principal's
 * authority. `observe` is the same message as context and nothing else — it
 * belongs to the transcript, grants nothing, and wakes no agent. `ignore` never
 * existed as far as Nox is concerned.
 *
 * The three are separate because the interesting future layer sits between the
 * last two: a gate that reads what was observed and decides whether anything is
 * worth saying. It cannot promote an observation into a turn under the
 * speaker's authority — nobody asked for anything — so it will speak under a
 * system principal, which starts with nothing granted.
 */
type IngressDecision =
  | { readonly kind: 'address' }
  | { readonly kind: 'ignore'; readonly reason: IngressRefusal }
  | { readonly kind: 'observe' };

type IngressRefusal =
  | 'bot'
  | 'channelNotAdmitted'
  | 'channelSenderNotAdmitted'
  | 'empty'
  | 'notAddressed'
  | 'self'
  | 'senderNotAdmitted'
  | 'threadsIgnored'
  | 'webhook';

/** The admission and ingress rules one configured Discord broker was given. */
interface IngressPolicy {
  /** Admitted guild channels, by channel ID. */
  readonly channels: ReadonlyMap<string, DiscordChannelPolicy>;
  /** User IDs allowed to hold a direct conversation. */
  readonly dms: ReadonlySet<string>;
  /** Words that count as Nox's name, lowercased. Includes its own username. */
  readonly names: readonly string[];
  /** Nox's own Discord user ID, learned when the socket became ready. */
  readonly selfId: string;
}

/**
 * Whether a channel is one this broker reads, and under which policy. A thread
 * inherits the policy of the channel it hangs from: a thread is a channel of its
 * own, so it is its own conversation, but it is not its own admission decision.
 */
function policyFor(
  policy: IngressPolicy,
  channelId: string,
  parentChannelId: string | undefined,
): DiscordChannelPolicy | undefined {
  const own = policy.channels.get(channelId);
  if (own !== undefined) return own;
  if (parentChannelId === undefined) return undefined;

  const parent = policy.channels.get(parentChannelId);
  return parent?.threads === 'inherit' ? parent : undefined;
}

/**
 * Whether one of Nox's names appears as a word. Deliberately narrow: a
 * substring match would have a bot called "nox" answering the word "obnoxious",
 * and being addressed is supposed to be something a person did on purpose.
 */
function namesNox(content: string, names: readonly string[]): boolean {
  if (names.length === 0) return false;

  const lowered = content.toLowerCase();
  return names.some((name) => {
    let from = lowered.indexOf(name);
    while (from !== -1) {
      const before = lowered[from - 1];
      const after = lowered[from + name.length];
      if (!isWordCharacter(before) && !isWordCharacter(after)) return true;
      from = lowered.indexOf(name, from + 1);
    }
    return false;
  });
}

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}_]/u.test(character);
}

/**
 * One slash command as it arrived, reduced to what admission is about.
 *
 * There is no content and no trigger here, and that is the whole difference from
 * a message: typing a command is addressing Nox on purpose, so `respondTo` has
 * nothing to decide and a command is never merely observed.
 */
interface IngressCommand {
  readonly channelId: string;
  /** Absent in a direct message: Discord sends no guild for one. */
  readonly guildId?: string;
  /** Set when the channel is a thread; the channel it hangs from. */
  readonly parentChannelId?: string;
  readonly senderId: string;
  /** The role IDs Discord reported for the sender; empty in a direct message. */
  readonly senderRoles: readonly string[];
}

/**
 * Whether a slash command may be answered where it was typed, and why not when
 * it may not.
 *
 * This exists because a globally published command is offered everywhere the bot
 * can be reached — every server it was ever added to, and every direct message —
 * while what this broker *reads* is a short list of admitted channels. Without
 * this, publishing globally would quietly turn a command into the one way into
 * Nox from a room nobody admitted. It answers the same two questions a message
 * answers first, and deliberately not the third: whether the room is admitted,
 * and whether this person may start a run in it.
 */
function admitsCommand(command: IngressCommand, policy: IngressPolicy): IngressRefusal | undefined {
  if (command.guildId === undefined) {
    return policy.dms.has(command.senderId) ? undefined : 'senderNotAdmitted';
  }

  const channel = policyFor(policy, command.channelId, command.parentChannelId);
  if (channel === undefined) {
    const parentAdmitted =
      command.parentChannelId !== undefined && policy.channels.has(command.parentChannelId);
    return parentAdmitted ? 'threadsIgnored' : 'channelNotAdmitted';
  }

  const admitted = admits(channel.senders, command.senderId, command.senderRoles);
  return admitted ? undefined : 'channelSenderNotAdmitted';
}

/**
 * Whether an admission list lets this person speak to Nox.
 *
 * Empty admits anyone the channel already lets speak, which is Discord's own
 * decision and a reasonable one for a private team channel. Otherwise an entry
 * matches either the member or one of the roles they hold — the union, because
 * a list of who may speak is a list of permissions and two of them do not
 * subtract.
 */
function admits(
  senders: readonly string[],
  senderId: string,
  senderRoles: readonly string[],
): boolean {
  if (senders.length === 0) return true;

  return senders.some((sender) =>
    isRoleRef(sender)
      ? senderRoles.includes(sender.slice(ROLE_PREFIX.length))
      : sender === senderId,
  );
}

/**
 * The whole ingress rule for a guild channel, and the only place it lives.
 *
 * The gateway filters nothing: any conversation ID a broker hands over becomes a
 * bound conversation answered by the configured agent. So this function is the
 * boundary, and everything it does not admit never becomes a kernel event.
 */
function decideIngress(message: IngressMessage, policy: IngressPolicy): IngressDecision {
  if (message.authorId === policy.selfId) return { kind: 'ignore', reason: 'self' };
  if (message.viaWebhook) return { kind: 'ignore', reason: 'webhook' };
  if (message.authorIsBot) return { kind: 'ignore', reason: 'bot' };

  // A direct message needs no rule beyond who is allowed to send one. There is
  // one person in it, everything they say is addressed to Nox, and the session
  // never becomes shared — which makes it the same conversation the browser
  // surface has, carried by a different transport. Nothing here can fall through
  // to the channel rules: a DM Nox does not accept is refused as a DM.
  if (message.guildId === undefined) {
    if (!policy.dms.has(message.authorId)) {
      return { kind: 'ignore', reason: 'senderNotAdmitted' };
    }
    return message.content.trim().length === 0
      ? { kind: 'ignore', reason: 'empty' }
      : { kind: 'address' };
  }

  const channel = policyFor(policy, message.channelId, message.parentChannelId);
  if (channel === undefined) {
    // Separated so the log says which of the two it was: a thread under an
    // admitted channel that declines to carry them is a configuration answer,
    // while an unknown channel is simply not this broker's business.
    const parentAdmitted =
      message.parentChannelId !== undefined && policy.channels.has(message.parentChannelId);
    return {
      kind: 'ignore',
      reason: parentAdmitted ? 'threadsIgnored' : 'channelNotAdmitted',
    };
  }

  // Whether this person may make the agent answer here at all. Checked before
  // the triggers rather than after, because someone who cannot start a run has
  // not addressed Nox by mentioning it — they are part of the room, and the room
  // is what `observe` is for.
  const admitted = admits(channel.senders, message.authorId, message.authorRoles);

  const addressed =
    admitted &&
    channel.respondTo.some((trigger) => {
      switch (trigger) {
        case 'all':
          return true;
        case 'mention':
          return message.mentionsSelf;
        case 'name':
          return namesNox(message.content, policy.names);
        case 'reply':
          return message.repliedToSelf;
      }
    });

  if (addressed) {
    return message.content.trim().length === 0
      ? { kind: 'ignore', reason: 'empty' }
      : { kind: 'address' };
  }

  if (channel.observe === 'channel') return { kind: 'observe' };

  return {
    kind: 'ignore',
    reason: admitted ? 'notAddressed' : 'channelSenderNotAdmitted',
  };
}

export { admitsCommand, decideIngress, namesNox, policyFor };

export type { IngressCommand, IngressDecision, IngressMessage, IngressPolicy, IngressRefusal };
