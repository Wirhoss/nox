import type { ChatProvider, Model } from "../provider";
import type { MessageContent, MessageContentStreamEvent, MessageContentToolCall, MessageContentToolResponse } from "./message";

enum StopReason {
  Completed,
  Aborted,
  MaxIterations,
}

enum AgentState {
  Idle,
  Running,
  Stopped
}

interface RunLoopResult {
  stopReason: StopReason;
}

export {
  AgentState,
  StopReason
};

interface AgentConfig {
  maxIterations: number;
  model: Model;
  provider: ChatProvider;
}

type AgentStreamEvent =
  | { type: "assistantTextFragment", text: string }
  | { type: "assistantMessage", message: MessageContent[] }
  | { type: "userMessage", message: MessageContent[] }
  | { type: "toolCall"; toolCall: MessageContentToolCall }
  | { type: "toolResponse"; toolResponse: MessageContentToolResponse }
  | { type: "error"; error: Error };

export type {
  AgentConfig,
  AgentStreamEvent,
  RunLoopResult
};