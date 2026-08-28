import { describe, expect, test } from 'bun:test';

import { discordChannelSchema } from './config';
import {
  admitsCommand,
  decideIngress,
  type IngressCommand,
  type IngressMessage,
  type IngressPolicy,
} from './ingress';

const SELF = '100000000000000001';
const ALICE = '200000000000000002';
const CHANNEL = '300000000000000003';
const THREAD = '400000000000000004';

function channel(
  overrides: Record<string, unknown> = {},
): ReturnType<typeof discordChannelSchema.parse> {
  return discordChannelSchema.parse(overrides);
}

function policy(overrides: Partial<IngressPolicy> = {}): IngressPolicy {
  return {
    channels: new Map([[CHANNEL, channel()]]),
    dms: new Set<string>(),
    names: ['nox'],
    selfId: SELF,
    ...overrides,
  };
}

function message(overrides: Partial<IngressMessage> = {}): IngressMessage {
  return {
    authorId: ALICE,
    authorIsBot: false,
    authorRoles: [],
    channelId: CHANNEL,
    content: 'hello',
    guildId: '500000000000000005',
    mentionsSelf: false,
    repliedToSelf: false,
    viaWebhook: false,
    ...overrides,
  };
}

describe('guild channels', () => {
  test('admits a mention, a reply, and a message that says the name', () => {
    const named = policy({
      channels: new Map([[CHANNEL, channel({ respondTo: ['mention', 'name', 'reply'] })]]),
    });

    expect(decideIngress(message({ mentionsSelf: true }), named).kind).toBe('address');
    expect(decideIngress(message({ repliedToSelf: true }), named).kind).toBe('address');
    expect(decideIngress(message({ content: 'nox, are you there?' }), named).kind).toBe('address');
  });

  test('only answers the triggers the channel actually configured', () => {
    const mentionOnly = policy({
      channels: new Map([[CHANNEL, channel({ respondTo: ['mention'] })]]),
    });

    expect(decideIngress(message({ content: 'nox?' }), mentionOnly)).toEqual({
      kind: 'ignore',
      reason: 'notAddressed',
    });
    expect(decideIngress(message({ repliedToSelf: true }), mentionOnly)).toEqual({
      kind: 'ignore',
      reason: 'notAddressed',
    });
  });

  test('takes the name as a word, never as a substring', () => {
    const named = policy({ channels: new Map([[CHANNEL, channel({ respondTo: ['name'] })]]) });

    expect(decideIngress(message({ content: 'that is obnoxious' }), named).kind).toBe('ignore');
    expect(decideIngress(message({ content: 'hey NOX!' }), named).kind).toBe('address');
  });

  test('reads the rest of the room only where the channel asked it to', () => {
    const quiet = policy();
    const watching = policy({
      channels: new Map([[CHANNEL, channel({ observe: 'channel' })]]),
    });

    expect(decideIngress(message(), quiet)).toEqual({ kind: 'ignore', reason: 'notAddressed' });
    expect(decideIngress(message(), watching)).toEqual({ kind: 'observe' });
  });

  test('never reads a channel nobody admitted', () => {
    expect(decideIngress(message({ channelId: THREAD, mentionsSelf: true }), policy())).toEqual({
      kind: 'ignore',
      reason: 'channelNotAdmitted',
    });
  });
});

describe('threads', () => {
  test('inherit the admission and the rule of the channel they hang from', () => {
    const decision = decideIngress(
      message({ channelId: THREAD, mentionsSelf: true, parentChannelId: CHANNEL }),
      policy(),
    );

    expect(decision.kind).toBe('address');
  });

  test('are refused distinguishably where the parent declines to carry them', () => {
    const ignoring = policy({
      channels: new Map([[CHANNEL, channel({ threads: 'ignore' })]]),
    });

    expect(
      decideIngress(
        message({ channelId: THREAD, mentionsSelf: true, parentChannelId: CHANNEL }),
        ignoring,
      ),
    ).toEqual({ kind: 'ignore', reason: 'threadsIgnored' });
  });
});

describe('direct messages', () => {
  test('need no trigger: everything an admitted sender says is addressed', () => {
    const direct = policy({ dms: new Set([ALICE]) });
    const dm = message({ channelId: THREAD, guildId: undefined });

    expect(decideIngress(dm, direct).kind).toBe('address');
  });

  test('are refused as direct messages rather than falling through to channels', () => {
    expect(decideIngress(message({ guildId: undefined }), policy())).toEqual({
      kind: 'ignore',
      reason: 'senderNotAdmitted',
    });
  });
});

describe('who is speaking', () => {
  test('never answers itself, another bot, or a webhook', () => {
    const open = policy({ channels: new Map([[CHANNEL, channel({ respondTo: ['all'] })]]) });

    expect(decideIngress(message({ authorId: SELF }), open)).toEqual({
      kind: 'ignore',
      reason: 'self',
    });
    expect(decideIngress(message({ authorIsBot: true }), open)).toEqual({
      kind: 'ignore',
      reason: 'bot',
    });
    expect(decideIngress(message({ viaWebhook: true }), open)).toEqual({
      kind: 'ignore',
      reason: 'webhook',
    });
  });

  test('drops a message with nothing said in it', () => {
    const open = policy({ channels: new Map([[CHANNEL, channel({ respondTo: ['all'] })]]) });

    expect(decideIngress(message({ content: '   ' }), open)).toEqual({
      kind: 'ignore',
      reason: 'empty',
    });
  });
});

describe('who may make it answer', () => {
  const BOB = '600000000000000006';

  test('an empty list means anyone the channel already lets speak', () => {
    const open = policy({ channels: new Map([[CHANNEL, channel({ respondTo: ['mention'] })]]) });

    expect(decideIngress(message({ authorId: BOB, mentionsSelf: true }), open).kind).toBe(
      'address',
    );
  });

  test('a listed sender addresses it; an unlisted one does not, however they ask', () => {
    const restricted = policy({
      channels: new Map([[CHANNEL, channel({ respondTo: ['all'], senders: [ALICE] })]]),
    });

    expect(decideIngress(message({ authorId: ALICE }), restricted).kind).toBe('address');
    expect(decideIngress(message({ authorId: BOB, mentionsSelf: true }), restricted)).toEqual({
      kind: 'ignore',
      reason: 'channelSenderNotAdmitted',
    });
  });

  test('an unlisted sender is still part of the room where the room is read', () => {
    const restricted = policy({
      channels: new Map([
        [CHANNEL, channel({ observe: 'channel', respondTo: ['all'], senders: [ALICE] })],
      ]),
    });

    // Being unable to start a run is not being absent from the conversation.
    expect(decideIngress(message({ authorId: BOB }), restricted)).toEqual({ kind: 'observe' });
  });
});

function command(overrides: Partial<IngressCommand> = {}): IngressCommand {
  return {
    channelId: CHANNEL,
    guildId: '500000000000000005',
    senderId: ALICE,
    senderRoles: [],
    ...overrides,
  };
}

describe('slash commands', () => {
  test('admits one typed in an admitted channel', () => {
    expect(admitsCommand(command(), policy())).toBeUndefined();
  });

  test('refuses a channel this broker does not read', () => {
    // A globally published command is offered in every server the bot is in;
    // which of those rooms Nox answers is still this configuration's decision.
    expect(admitsCommand(command({ channelId: THREAD }), policy())).toBe('channelNotAdmitted');
  });

  test('inherits the admission of the channel a thread hangs from', () => {
    expect(
      admitsCommand(command({ channelId: THREAD, parentChannelId: CHANNEL }), policy()),
    ).toBeUndefined();
    expect(
      admitsCommand(
        command({ channelId: THREAD, parentChannelId: CHANNEL }),
        policy({ channels: new Map([[CHANNEL, channel({ threads: 'ignore' })]]) }),
      ),
    ).toBe('threadsIgnored');
  });

  test('refuses somebody the channel does not let start a run', () => {
    expect(
      admitsCommand(
        command(),
        policy({ channels: new Map([[CHANNEL, channel({ senders: [SELF] })]]) }),
      ),
    ).toBe('channelSenderNotAdmitted');
  });

  test('admits a direct message only from somebody allowed to hold one', () => {
    const guildless = command({ guildId: undefined });

    expect(admitsCommand(guildless, policy({ dms: new Set([ALICE]) }))).toBeUndefined();
    expect(admitsCommand(guildless, policy())).toBe('senderNotAdmitted');
  });
});

describe('role-based admission', () => {
  const OPS = '700000000000000007';
  const CAROL = '800000000000000008';

  function byRole() {
    return policy({
      channels: new Map([[CHANNEL, channel({ respondTo: ['all'], senders: [`role:${OPS}`] })]]),
    });
  }

  test('admits someone holding an admitted role', () => {
    expect(decideIngress(message({ authorId: CAROL, authorRoles: [OPS] }), byRole())).toEqual({
      kind: 'address',
    });
  });

  test('refuses someone holding none of them', () => {
    expect(decideIngress(message({ authorId: CAROL, authorRoles: [] }), byRole())).toEqual({
      kind: 'ignore',
      reason: 'channelSenderNotAdmitted',
    });
  });

  test('takes the union of members and roles', () => {
    const mixed = policy({
      channels: new Map([
        [CHANNEL, channel({ respondTo: ['all'], senders: [ALICE, `role:${OPS}`] })],
      ]),
    });

    expect(decideIngress(message({ authorId: ALICE, authorRoles: [] }), mixed)).toEqual({
      kind: 'address',
    });
    expect(decideIngress(message({ authorId: CAROL, authorRoles: [OPS] }), mixed)).toEqual({
      kind: 'address',
    });
  });

  test('admits a slash command by role too, so both doors ask the same question', () => {
    expect(
      admitsCommand(command({ senderId: CAROL, senderRoles: [OPS] }), byRole()),
    ).toBeUndefined();
    expect(admitsCommand(command({ senderId: CAROL, senderRoles: [] }), byRole())).toBe(
      'channelSenderNotAdmitted',
    );
  });
});
