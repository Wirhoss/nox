import type { BrokerShape, BrokerStartPlan } from './brokerServer';
import type { ToolSetChannel } from './toolSet';
import type { Broker, BrokerHost, OutboundEvent } from '@nox/extension-api';

/** What the transport needs from a process: calls out, and answers to calls in. */
interface BrokerChannel extends ToolSetChannel {
  answer(
    prefix: string,
    handler: (method: string, params: readonly unknown[]) => Promise<unknown>,
  ): void;
}

interface ConnectBrokerOptions {
  /** Identifies this grant; the child derives its artifact scope from it. */
  readonly brokerId: string;
  readonly channel: BrokerChannel;
}

/**
 * A transport running in another process.
 *
 * The first contract here that goes both ways: the gateway hands a `Broker` a
 * `BrokerHost` and the transport calls into it — for every message that
 * arrives, for every command a person types. So `start` does two things: it
 * registers the host on this side so the child can reach it, and only then
 * tells the child to start. In that order, because a transport that came up
 * first could deliver an inbound message into a host nobody had wired yet.
 *
 * The optional members are reported by the far side rather than offered.
 * `canDeliverTo` absent means the host treats an address as acceptable; present
 * and throwing would make every scheduled delivery fail. `principalGroups`
 * absent means a sender belongs to no groups; present and throwing would refuse
 * authority the operator granted. Both differences are silent, which is why
 * neither is guessed at.
 */
async function connectBroker(options: ConnectBrokerOptions): Promise<Broker> {
  const { brokerId, channel } = options;
  const shape = (await channel.invoke('broker.shape')) as BrokerShape;

  const canDeliverTo = async (channelId: string): Promise<boolean> =>
    (await channel.invoke('broker.canDeliverTo', channelId)) as boolean;

  const openScheduledConversation = async (): Promise<string> =>
    (await channel.invoke('broker.openScheduledConversation')) as string;

  const principalGroups = async (subject: string): Promise<readonly string[]> =>
    (await channel.invoke('broker.principalGroups', subject)) as readonly string[];

  return Object.freeze({
    ...(shape.canDeliverTo ? { canDeliverTo } : {}),
    capabilities: shape.capabilities,
    deliver: async (event: OutboundEvent): Promise<void> => {
      await channel.invoke('broker.deliver', event);
    },
    ...(shape.openScheduledConversation ? { openScheduledConversation } : {}),
    ...(shape.principalGroups ? { principalGroups } : {}),
    start: async (host: BrokerHost): Promise<void> => {
      channel.answer('brokerhost.', async (method, params) => await hostCall(host, method, params));
      const plan: BrokerStartPlan = {
        brokerId,
        commands: host.commands,
        ...(host.defaultAgentId === undefined ? {} : { defaultAgentId: host.defaultAgentId }),
      };
      await channel.invoke('broker.start', plan);
    },
    stop: async (): Promise<void> => {
      await channel.invoke('broker.stop');
    },
  });
}

/**
 * Routes one callback from the transport to the host it was given.
 *
 * `agentIds` is the only synchronous member of `BrokerHost`, and it is read on
 * the hot path of every inbound message. The child asks for it once at start
 * and keeps the answer, so this is where that one crossing is served.
 */
async function hostCall(
  host: BrokerHost,
  method: string,
  params: readonly unknown[],
): Promise<unknown> {
  switch (method) {
    case 'brokerhost.agentIds':
      return await Promise.resolve(host.agentIds());
    case 'brokerhost.command':
      return await host.command(params[0] as never);
    case 'brokerhost.history':
      return await host.history(String(params[0]), params[1] as never);
    case 'brokerhost.receive':
      return await host.receive(params[0] as never);
    case 'brokerhost.sessions':
      return await host.sessions();
    default:
      throw new TypeError(`A broker host has no method "${method}".`);
  }
}

export { connectBroker };
export type { BrokerChannel, ConnectBrokerOptions };
