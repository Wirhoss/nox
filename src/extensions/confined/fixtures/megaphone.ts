import type { Broker, BrokerHost, OutboundEvent } from '@nox/extension-api';

/**
 * A transport for the broker tests.
 *
 * `full` has every optional member; `sparse` has none — because absence is
 * meaningful here in a way that is silent when got wrong. A missing
 * `canDeliverTo` means the host accepts an address it cannot check; one that is
 * present and throws makes every scheduled delivery fail instead.
 */

let host: BrokerHost | undefined;
const delivered: OutboundEvent[] = [];

function started(): BrokerHost {
  if (host === undefined) throw new Error('The broker has not been started.');
  return host;
}

const full: Broker = {
  canDeliverTo: (channelId) => Promise.resolve(channelId.startsWith('room-')),
  capabilities: { commands: true, streaming: true },
  deliver: (event) => {
    delivered.push(event);
    return Promise.resolve();
  },
  openScheduledConversation: () => 'room-scheduled',
  principalGroups: (subject) => (subject === 'ada' ? ['admins'] : []),
  start: (given) => {
    host = given;
    return Promise.resolve();
  },
  stop: () => {
    host = undefined;
    return Promise.resolve();
  },
};

const sparse: Broker = {
  capabilities: {},
  deliver: () => Promise.resolve(),
  start: (given) => {
    host = given;
    return Promise.resolve();
  },
  stop: () => Promise.resolve(),
};

export default {
  /** What the transport was told to send, so a delivery can be inspected. */
  delivered: (): readonly OutboundEvent[] => delivered,
  full: (): Broker => full,

  /** Everything below runs inside the child and calls back into the host. */
  callAgentIds: (): readonly string[] => started().agentIds(),
  callArtifactScope: (conversationId: string): unknown => started().artifactScope(conversationId),
  callCommands: (): unknown => started().commands,
  callHistory: async (conversationId: string): Promise<unknown> =>
    await started().history(conversationId),
  callReceive: async (text: string): Promise<unknown> =>
    await started().receive({
      channelId: 'room-1',
      content: [{ text, type: 'text' }],
      conversationId: 'room-1',
      kind: 'message',
      sender: { subject: 'ada' },
    } as never),
  callSessions: async (): Promise<unknown> => await started().sessions(),
  /** Whether the dates the host answered with are Dates on this side. */
  sessionDateTypes: async (): Promise<readonly string[]> =>
    (await started().sessions()).map((session) =>
      [
        session.startedAt instanceof Date ? 'Date' : typeof session.startedAt,
        session.updatedAt instanceof Date ? 'Date' : typeof session.updatedAt,
      ].join(','),
    ),
  /** Writes one line, to prove a confined logger reaches Nox's log. */
  log: (message: string): null => {
    started().logger.info({ shouted: true }, message);
    return null;
  },
  /** Whether the host's stop signal reached the transport. */
  stopped: (): boolean => started().signal.aborted,

  sparse: (): Broker => sparse,
};
