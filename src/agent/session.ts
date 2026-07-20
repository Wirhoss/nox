import { EscalationHub } from '../gate';
import { toUserMessage } from '../provider';
import { EventLog } from '../utils';

import { Runner } from './runner';

import type { PendingEscalation, ToolGate } from '../gate';
import type { ChatProvider, Message, ModelConfig } from '../provider';
import type { Context } from './context';
import type { AgentStreamEvent, StopReason } from './runner';

interface AgentConfig {
  maxIterations: number;
  modelConfig: ModelConfig;
  provider: ChatProvider;
  gate?: ToolGate;
  escalationTimeoutMs?: number;
  onEvent?: (event: AgentStreamEvent, cursor: number) => void;
}

class AgentSession {
  private readonly eventLog: EventLog<AgentStreamEvent>;
  private readonly escalation = new EscalationHub();

  private agentConfig: AgentConfig;
  private context: Context;
  private runner: Runner;

  constructor(context: Context, agentConfig: AgentConfig) {
    this.context = context;
    this.agentConfig = agentConfig;
    this.eventLog = new EventLog(agentConfig.onEvent);
    this.runner = new Runner(
      context,
      this.eventLog,
      agentConfig.provider,
      agentConfig.modelConfig,
      {
        maxIterations: agentConfig.maxIterations,
        gate: agentConfig.gate,
        escalation: this.escalation,
        escalationTimeoutMs: agentConfig.escalationTimeoutMs,
      }
    );
  }

  public get isRunning(): boolean {
    return this.runner.isRunning;
  }

  public get idle(): Promise<void> {
    return this.runner.idle;
  }

  public get history(): readonly Message[] {
    return this.context.messageHistory;
  }

  public get eventCursor(): number {
    return this.eventLog.length;
  }

  public subscribeToEvents(from = 0): AsyncGenerator<AgentStreamEvent> {
    return this.eventLog.subscribe(from);
  }

  public run(message: string): Promise<StopReason> {
    return this.runner.run(toUserMessage(message));
  }

  public steer(message: string): Promise<StopReason> {
    return this.runner.steer(toUserMessage(message));
  }

  public abort(): Promise<boolean> {
    return this.runner.abort();
  }

  public stop(): Promise<void> {
    return this.runner.stop();
  }

  public resolvePermission(requestId: string, approved: boolean): boolean {
    return this.escalation.resolve(requestId, approved);
  }

  public listPendingPermissions(): PendingEscalation[] {
    return this.escalation.listPending();
  }
}

export {
  AgentSession,
};
