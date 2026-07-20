import { EventLog } from '../utils';

import type {
  Message,
  MessageContent,
  ModelConfig,
  Provider,
  ProviderStream,
  ToolCallMessage,
  ToolResponseMessage,
  Usage,
  UserMessage,
} from '../provider';
import type { Context } from './context';

enum RunnerState {
  Idle,
  Running,
  Stopped
}

enum StopReason {
  Completed,
  Aborted,
  MaxIterations,
}

type AgentStreamEvent =
  | { type: 'assistantTextFragment', text: string }
  | { type: 'message', message: Message }
  | { type: 'error'; error: Error };

class Runner {
  private eventLog: EventLog<AgentStreamEvent>;
  private context: Context;

  private maxIterations: number;

  private provider: Provider;
  private model: ModelConfig;

  private abortController?: AbortController;
  private state: RunnerState = RunnerState.Idle;
  private idlePromise: Promise<void> = Promise.resolve();
  private idleResolve: (() => void) | undefined;

  constructor(context: Context, eventLog: EventLog<AgentStreamEvent>, provider: Provider, model: ModelConfig, maxIterations: number) {
    this.context = context;
    this.eventLog = eventLog;
    this.provider = provider;
    this.model = model;
    this.maxIterations = maxIterations;
  }

  private getMessageStream(): ProviderStream {
    const stream: ProviderStream = this.provider.getMessageStream(
      this.context.systemPrompt,
      this.context.messageHistory,
      Object.values(this.context.tools),
      { model: this.model, signal: this.abortController?.signal }
    );
    return stream;
  }

  private handleText(text: string): void {
    this.eventLog.push({
      type: 'assistantTextFragment',
      text: text,
    });
  }

  private async handleToolCall(toolCall: ToolCallMessage): Promise<ToolResponseMessage> {
    this.eventLog.push({
      type: 'message',
      message: toolCall,
    });
    const toolResponse: ToolResponseMessage = {
      role: 'toolResponse',
      name: toolCall.name,
      trackId: toolCall.trackId,
      response: [],
    };
    try {
      const tool = this.context.tools[toolCall.name];
      if (!tool) {
        toolResponse.response.push({
          type: 'text',
          text: `Tool ${toolCall.name} not found.`,
        });
        toolResponse.isError = true;
      } else {
        const parsedArguments = tool.parameters.parse(toolCall.arguments);
        let response: MessageContent[] = [];
        if (tool.type === 'immediate') {
          response = await tool.call(parsedArguments);
        } else if (tool.type === 'deferred') {
          // TODO: Handle async tool calls properly, including acknowledging the call and waiting for the result.
        }
        toolResponse.response = response ?? [];
        toolResponse.isError = false;
      }
    } catch (error) {
      toolResponse.response.push({
        type: 'text',
        text: `Error executing tool ${toolCall.name}: ${(error as Error).message}`,
      });
      toolResponse.isError = true;
    }
    this.eventLog.push({
      type: 'message',
      message: toolResponse,
    });
    return toolResponse;
  }

  private async commitAssistantMessage(messages: Message[], usage?: Usage): Promise<Message[]> {
    for (const message of messages) {
      this.eventLog.push({
        type: 'message',
        message: message,
      });
      this.context.addMessage(message);
    }
    if (usage) {
      this.context.inputTokens = usage.inputTokens;
      this.context.outputTokens = (this.context.outputTokens ?? 0) + usage.outputTokens;
      this.context.cacheReadTokens = usage.cacheReadTokens ?? 0;
    }
    return messages;
  }

  private async runLoop(userMessage: UserMessage): Promise<StopReason> {
    this.context.addMessage(userMessage);
    this.eventLog.push({ type: 'message', message: userMessage });

    for (let i = 0; i < this.maxIterations; i++) {
      const stream = this.getMessageStream();
      const toolCalls: Promise<ToolResponseMessage>[] = [];
      for await (const event of stream) {
        if (event.type === 'textFragment') {
          this.handleText(event.text);
        } else if (event.type === 'toolCall') {
          toolCalls.push(this.handleToolCall(event.toolCall));
        } else if (event.type === 'end') {
          await this.commitAssistantMessage(event.messages, event.usage);
        }
      }

      const toolResponses = await Promise.all(toolCalls);

      if (this.abortController?.signal.aborted) return StopReason.Aborted;
      if (toolResponses.length === 0) return StopReason.Completed;

      for (const toolResponse of toolResponses) {
        this.context.addMessage(toolResponse);
      }
    }
    this.context.addMessage({
      role: 'user',
      content: [{ type: 'text', text: 'Maximum tool iterations reached.' }],
    });
    return StopReason.MaxIterations;
  }

  public async run(userMessage: UserMessage): Promise<StopReason> {
    if (this.state === RunnerState.Running) {
      throw new Error('Agent is already running');
    } else if (this.state === RunnerState.Stopped) {
      throw new Error('Agent has been stopped and cannot be restarted');
    }

    this.idlePromise = new Promise(resolve => {
        this.idleResolve = resolve;
    });

    this.state = RunnerState.Running;
    this.abortController = new AbortController();

    try {
      return await this.runLoop(userMessage);
    } catch (error) {
      if (this.abortController?.signal.aborted) {
        return StopReason.Aborted;
      }
      const parsedError = error instanceof Error ? error : new Error(String(error));
      this.eventLog.push({
        type: 'error',
        error: parsedError,
      });
      throw new Error(`Error in agent run loop: ${parsedError.message}`);
    } finally {
      this.state = RunnerState.Idle;
      this.abortController = undefined;
      this.idleResolve?.();
    }
  }

  public async steer(userMessage: UserMessage): Promise<StopReason> {
    if (this.state !== RunnerState.Running) {
      throw new Error('Cannot steer agent when it is not running.');
    }
    this.abortController?.abort();
    await this.idlePromise;
    return await this.run(userMessage);
  }

  public async stop(): Promise<void> {
    if (this.state === RunnerState.Idle) {
      return Promise.resolve();
    }
    this.abortController?.abort();
    await this.idlePromise;
    this.eventLog.close();
    this.state = RunnerState.Stopped;
  }
}

export {
  Runner
};

export type {
  AgentStreamEvent
};