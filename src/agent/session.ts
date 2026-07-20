import { EventLog } from '../utils';

import { Runner } from './runner';

import type { ChatProvider, ModelConfig, UserMessage } from '../provider';
import type { Context } from './context';
import type { AgentStreamEvent } from './runner';

interface AgentConfig {
  maxIterations: number;
  modelConfig: ModelConfig;
  provider: ChatProvider;
}

class AgentSession {
  private readonly eventLog = new EventLog<AgentStreamEvent>();

  private agentConfig: AgentConfig;
  private context: Context;
  private runner: Runner;

  constructor(context: Context, agentConfig: AgentConfig) {
    this.context = context;
    this.agentConfig = agentConfig;
    this.runner = new Runner(
      context,
      this.eventLog,
      agentConfig.provider,
      agentConfig.modelConfig,
      agentConfig.maxIterations
    );
  }

  public subscribeToEvents(from = 0): AsyncGenerator<AgentStreamEvent> {
    return this.eventLog.subscribe(from);
  }

  public async steer(message: string): Promise<void> {
    const userMessage: UserMessage = {
      role: 'user',
      content: [{
        type: 'text',
        text: message,
      }],
    };
    await this.runner.steer(userMessage);
  }
}

export {
  AgentSession,
};