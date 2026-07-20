import { createLogger } from '../logger';

import type { BaseBroker } from './broker';
import type { BrokerBaseConfig } from './config';
import type { MessageGateway } from './gateway';

const logger = createLogger('gateway');

interface BrokerClass {
  new (config: BrokerBaseConfig): BaseBroker;
}

const builtinBrokerClasses: Record<string, BrokerClass> = {};

type BrokerConfig = BrokerBaseConfig & { type: string };

class BrokerRegistry {
  private static _instance: BrokerRegistry;

  private brokerClasses: Record<string, BrokerClass> = {
    ...builtinBrokerClasses,
  };
  private brokers: Record<string, BaseBroker> = {};
  private initialized: boolean = false;

  private constructor() {}

  public static get instance(): BrokerRegistry {
    if (!BrokerRegistry._instance) {
      BrokerRegistry._instance = new BrokerRegistry();
    }
    return BrokerRegistry._instance;
  }

  public getBroker(brokerId: string): BaseBroker | null {
    return this.brokers[brokerId] || null;
  }

  public async init(configs: Record<string, BrokerConfig>, gateway: MessageGateway): Promise<void> {
    if (this.initialized) {
      throw new Error('BrokerRegistry already initialized.');
    }
    this.initialized = true;

    const results = await Promise.allSettled(
      Object.entries(configs).map(([brokerId, config]) =>
        this.initBroker(brokerId, config, gateway),
      ),
    );
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value != null) {
        this.brokers[result.value.brokerId] = result.value.broker;
      }
    }
    logger.info({ brokers: Object.keys(this.brokers) }, 'Brokers initialized.');
  }

  public async stopAll(): Promise<void> {
    const results = await Promise.allSettled(
      Object.entries(this.brokers).map(async ([brokerId, broker]) => {
        await broker.stop();
        logger.info({ brokerId }, 'Broker stopped.');
      }),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.error({ err: result.reason }, 'Broker failed to stop.');
      }
    }
    this.brokers = {};
  }

  private async initBroker(brokerId: string, config: BrokerConfig, gateway: MessageGateway): Promise<{ broker: BaseBroker; brokerId: string } | null> {
    const BrokerClassRef = this.brokerClasses[config.type];
    if (!BrokerClassRef) {
      logger.warn({ brokerId, type: config.type }, 'Unknown broker type, dropping it.');
      return null;
    }
    try {
      const broker = new BrokerClassRef(config);
      await broker.start(gateway.createInbox(brokerId, broker));
      return { broker, brokerId };
    } catch (error) {
      logger.warn({ err: error, brokerId }, 'Broker failed to start, dropping it.');
      return null;
    }
  }
}

export {
  BrokerRegistry,
  builtinBrokerClasses,
};

export type {
  BrokerConfig,
};
