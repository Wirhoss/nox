import { brokerBaseConfigSchema } from './config';

import type { BrokerBaseConfig } from './config';
import type { InboundEnvelope, SessionEventEnvelope } from './events';

type BrokerDelivery = 'fragments' | 'messages';

interface GatewayInbox {
  openConversation(conversationId: string, blueprintId?: string): { sessionId: string };
  submit(conversationId: string, envelope: InboundEnvelope): void;
}

abstract class BaseBroker {
  static readonly configSchema = brokerBaseConfigSchema;

  public readonly defaultBlueprintId: string;
  public readonly debounceMs?: number;

  constructor(config: BrokerBaseConfig) {
    this.defaultBlueprintId = config.defaultBlueprintId;
    this.debounceMs = config.debounceMs;
  }

  public abstract readonly delivery: BrokerDelivery;

  public abstract start(inbox: GatewayInbox): Promise<void>;
  public abstract stop(): Promise<void>;

  public abstract deliver(conversationId: string, envelope: SessionEventEnvelope): Promise<void>;
}

export {
  BaseBroker,
};

export type {
  BrokerDelivery,
  GatewayInbox,
};
