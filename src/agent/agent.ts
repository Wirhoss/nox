import {
  AgentState,
  StopReason,
} from "../types";
import { EventLog } from "../utils";

import { Context } from "./context";

import type {
  AgentConfig,
  AgentStreamEvent,
  Message,
  MessageContent,
  MessageContentToolCall,
  MessageContentToolResponse,
  RunLoopResult,
  Tool,
  ToolResponse,
} from "../types";

class Agent {
  private abortController?: AbortController;
  private readonly eventLog = new EventLog<AgentStreamEvent>();
  private idleResolve?: (value: void | PromiseLike<void>) => void;
  private state = AgentState.Idle;

  private context: Context;

  private agentConfig: AgentConfig;

  constructor(systemPrompt: string, chatHistory: Message[], tools: Tool[], agentConfig: AgentConfig) {
    this.context = new Context(systemPrompt, chatHistory, tools);
    this.agentConfig = agentConfig;
  }

  private async abort(): Promise<void> {
    if (this.state === AgentState.Idle) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.idleResolve = resolve;
      this.abortController?.abort();
    });
  }

  private async handleToolCall(toolCall: MessageContentToolCall): Promise<MessageContentToolResponse> {
    const toolResponse: MessageContentToolResponse = {
      type: "tool_response",
      name: toolCall.name,
      trackId: toolCall.trackId,
      response: [],
    };
    try {
      const tool = this.context.tools[toolCall.name];
      if (!tool) {
        toolResponse.response.push({
          type: "text",
          text: `Tool ${toolCall.name} not found.`,
        });
        toolResponse.isError = true;
      } else {
        const parsedArguments = tool.parameters.parse(toolCall.arguments);
        let response: ToolResponse = [];
        if (tool.type === "sync") {
          response = await tool.call(parsedArguments);
        } else if (tool.type === "async") {
          // TODO: Handle async tool calls properly, including acknowledging the call and waiting for the result.
        }
        toolResponse.response = response ?? [];
        toolResponse.isError = false;
      }
    } catch (error) {
      toolResponse.response.push({
        type: "text",
        text: `Error executing tool ${toolCall.name}: ${(error as Error).message}`,
      });
      toolResponse.isError = true;
    }
    return toolResponse;
  }

  private async runLoop(
    userMessage: Message,
  ): Promise<RunLoopResult> {
    this.context.addMessage(userMessage);

    this.eventLog.push({
      type: "userMessage",
      message: userMessage.content,
    });

    for (let i = 0; i < this.agentConfig.maxIterations; i++) {
      const stream = this.agentConfig.provider.getMessageStream(
        this.context.systemPrompt,
        this.context.chatHistory,
        Object.values(this.context.tools),
        { model: this.agentConfig.model, signal: this.abortController?.signal }
      );

      const assistantContent: MessageContent[] = [];
      const toolResponseContent: MessageContent[] = [];
      const toolCallsRequested: MessageContentToolCall[] = [];
      let aborted = false;

      for await (const event of stream) {
        if (event.type === "text") {
          this.eventLog.push({
            type: "assistantTextFragment",
            text: event.text,
          });
        } else if (event.type === "toolCall") {
          this.eventLog.push({
            type: "toolCall",
            toolCall: event.toolCall,
          });
          toolCallsRequested.push(event.toolCall);
        } else if (event.type === "end") {
          this.eventLog.push({
            type: "assistantMessage",
            message: event.content,
          });
          assistantContent.push(...event.content);
          aborted = event.aborted === true;
          if (event.usage) {
            this.context.inputTokens = event.usage.inputTokens;
            this.context.outputTokens = (this.context.outputTokens ?? 0) + event.usage.outputTokens;
            this.context.cacheReadTokens = event.usage.cacheReadTokens ?? 0;
          }
        }
      }

      const toolResponses = await Promise.all(toolCallsRequested.map(async (toolCall) => await this.handleToolCall(toolCall)));
      toolResponses.forEach((toolResponse) => {
        toolResponseContent.push(toolResponse);
        this.eventLog.push({
          type: "toolResponse",
          toolResponse,
        });
      });

      if (assistantContent.length > 0) {
        this.context.addMessage({ role: "assistant", content: assistantContent });
      }
      if (aborted) return { stopReason: StopReason.Aborted };
      if (toolResponseContent.length === 0) return { stopReason: StopReason.Completed };
      this.context.addMessage({ role: "user", content: toolResponseContent });
    }
    this.context.addMessage({
      role: "user",
      content: [{ type: "text", text: "Maximum tool iterations reached. Summarize progress and stop." }],
    });
    return { stopReason: StopReason.MaxIterations };
  }

  public async run(userMessage: Message): Promise<RunLoopResult> {
    if (this.state === AgentState.Running) {
      throw new Error("Agent is already running");
    } else if (this.state === AgentState.Stopped) {
      throw new Error("Agent has been stopped and cannot be restarted");
    }

    this.state = AgentState.Running;
    this.abortController = new AbortController();

    try {
      return await this.runLoop(userMessage);
    } catch (error) {
      if (this.abortController?.signal.aborted) {
        return { stopReason: StopReason.Aborted };
      }
      const parsedError = error instanceof Error ? error : new Error(String(error));
      this.eventLog.push({
        type: "error",
        error: parsedError,
      });
      throw new Error(`Error in agent run loop: ${parsedError.message}`);
    } finally {
      this.state = AgentState.Idle;
      this.abortController = undefined;
      this.idleResolve?.();
    }
  }

  public async steer(userMessage: Message): Promise<RunLoopResult> {
    if (this.state !== AgentState.Running) {
      throw new Error("Cannot steer agent when it is not running.");
    }
    await this.abort();
    return await this.run(userMessage);
  }

  public async stop(): Promise<void> {
    if (this.state === AgentState.Idle) {
      return Promise.resolve();
    }
    await this.abort();
    this.eventLog.close();
    this.state = AgentState.Stopped;
  }

  public streamEvents(from = 0): AsyncGenerator<AgentStreamEvent> {
    return this.eventLog.subscribe(from);
  }
}

export { Agent };