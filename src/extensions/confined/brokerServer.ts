import { artifactConversationScope } from '../../artifact/types';
import { callHost, send } from './hostChannel';

import type {
  Broker,
  BrokerCommandSpec,
  BrokerHistory,
  BrokerHistoryOptions,
  BrokerHost,
  BrokerSession,
  CommandInvocation,
  CommandRejection,
  InboundEvent,
  InboundRejection,
  Logger,
  OutboundEvent,
} from '@nox/extension-api';

/**
 * The child's half of a broker.
 *
 * The first thing here that goes both ways. A tool set and a memory are asked
 * questions and answer them; a transport is *given* a host and calls into it —
 * that is what `start(host)` hands over. So the `BrokerHost` the extension
 * receives is built here out of messages, and every method on it is a call
 * back across the channel.
 */

/** What the host tells the child once, at start, instead of on every call. */
interface BrokerStartPlan {
  readonly brokerId: string;
  readonly commands: readonly BrokerCommandSpec[];
  readonly defaultAgentId?: string;
}

/** Which optional members the far side's broker actually has. */
interface BrokerShape {
  readonly canDeliverTo: boolean;
  readonly capabilities: Broker['capabilities'];
  readonly openScheduledConversation: boolean;
  readonly principalGroups: boolean;
}

/**
 * A logger that is a message.
 *
 * A confined child cannot open Nox's log file and should not be able to. The
 * host stamps every line with the extension that produced it, so a package
 * cannot write a line attributing itself to something else.
 */
function crossedLogger(name: string): Logger {
  const at =
    (level: 'debug' | 'error' | 'info' | 'warn') =>
    (fields: Readonly<Record<string, unknown>>, message: string): void => {
      send({ fields: { ...fields, logger: name }, kind: 'log', level, message });
    };
  return {
    child: (childName: string) => crossedLogger(`${name}.${childName}`),
    debug: at('debug'),
    error: at('error'),
    info: at('info'),
    // The channel carries four levels, and trace is the one nothing downstream
    // reads across a boundary. Folded into debug rather than dropped.
    trace: at('debug'),
    warn: at('warn'),
  };
}

/**
 * `agentIds()` is synchronous in the contract and called on the hot path of
 * every inbound message, so it is fetched once at start and read from here.
 *
 * The set changes only when configuration is reloaded, which restarts the
 * broker — so a value that went stale would mean a broker that outlived its own
 * start, which is a different bug and would show up as one.
 */
let agentIds: readonly string[] = [];

async function refreshAgentIds(): Promise<void> {
  agentIds = (await callHost('brokerhost.agentIds')) as readonly string[];
}

class BrokerServer {
  readonly #broker: Broker;
  readonly #stopping = new AbortController();

  constructor(broker: Broker) {
    this.#broker = broker;
  }

  public shape(): BrokerShape {
    return {
      canDeliverTo: this.#broker.canDeliverTo !== undefined,
      capabilities: this.#broker.capabilities,
      openScheduledConversation: this.#broker.openScheduledConversation !== undefined,
      principalGroups: this.#broker.principalGroups !== undefined,
    };
  }

  public async start(plan: BrokerStartPlan): Promise<void> {
    await this.#broker.start(this.#host(plan));
  }

  public async stop(): Promise<void> {
    this.#stopping.abort();
    await this.#broker.stop();
  }

  public async deliver(event: OutboundEvent): Promise<void> {
    await this.#broker.deliver(event);
  }

  public async canDeliverTo(channelId: string): Promise<boolean> {
    if (this.#broker.canDeliverTo === undefined) {
      throw new TypeError('This broker cannot check an address.');
    }
    return await this.#broker.canDeliverTo(channelId, this.#stopping.signal);
  }

  public async openScheduledConversation(): Promise<string> {
    if (this.#broker.openScheduledConversation === undefined) {
      throw new TypeError('This broker does not open scheduled conversations.');
    }
    return await this.#broker.openScheduledConversation();
  }

  public async principalGroups(subject: string): Promise<readonly string[]> {
    if (this.#broker.principalGroups === undefined) {
      throw new TypeError('This broker has no notion of groups.');
    }
    return await this.#broker.principalGroups(subject);
  }

  /**
   * The host, as the extension sees it.
   *
   * Two members are answered here rather than over the channel, and both for
   * the same reason: they are not decisions, they are facts the host already
   * stated. `commands` and `defaultAgentId` arrive once in the start plan, and
   * the artifact scope is a pure function of the broker id the host assigned —
   * so the transport still cannot choose its own scope, and asking for one
   * would be a round trip to recompute something known.
   */
  #host(plan: BrokerStartPlan): BrokerHost {
    return {
      agentIds: () => agentIds,
      artifactScope: (conversationId: string) =>
        artifactConversationScope(plan.brokerId, conversationId),
      command: async (invocation: CommandInvocation) =>
        (await callHost('brokerhost.command', invocation)) as CommandRejection | undefined,
      commands: plan.commands,
      ...(plan.defaultAgentId === undefined ? {} : { defaultAgentId: plan.defaultAgentId }),
      history: async (conversationId: string, options?: BrokerHistoryOptions) =>
        (await callHost('brokerhost.history', conversationId, options)) as
          BrokerHistory | undefined,
      logger: crossedLogger('broker'),
      receive: async (event: InboundEvent) =>
        (await callHost('brokerhost.receive', event)) as InboundRejection | undefined,
      sessions: async () => (await callHost('brokerhost.sessions')) as readonly BrokerSession[],
      signal: this.#stopping.signal,
    };
  }
}

export { BrokerServer, crossedLogger, refreshAgentIds };
export type { BrokerShape, BrokerStartPlan };
