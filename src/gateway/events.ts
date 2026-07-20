import type { AgentStreamEvent } from '../agent/runner';
import type { Message } from '../provider';

/** Wire-safe projection of AgentStreamEvent (Error instances don't serialize). */
type GatewayEvent =
  | { type: 'assistantTextFragment'; text: string }
  | { type: 'error'; message: string }
  | { type: 'message'; message: Message }
  | { type: 'permissionRequest'; requestId: string; toolName: string; toolArguments: Record<string, unknown>; reason: string }
  | { type: 'permissionResolved'; requestId: string; resolution: 'approved' | 'denied' | 'timeout' | 'aborted' }
  | { type: 'runStarted'; runId: string; modelId: string; startedAt: string }
  | {
    type: 'runCompleted';
    runId: string;
    status: 'completed' | 'aborted' | 'maxIterations' | 'failed';
    durationMs: number;
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  };

type SessionEventEnvelope = {
  cursor: number;
  event: GatewayEvent;
};

type InboundEnvelope =
  | { kind: 'chat'; text: string; steer?: boolean }
  | { kind: 'control'; action: string; payload?: Record<string, unknown> };

function serializeEvent(event: AgentStreamEvent): GatewayEvent {
  if (event.type === 'error') {
    return { type: 'error', message: event.error.message };
  }
  return event;
}

function isCoarseEvent(event: GatewayEvent): boolean {
  return event.type === 'error'
    || event.type === 'permissionRequest'
    || event.type === 'permissionResolved'
    || (event.type === 'message' && event.message.role === 'assistant');
}

export {
  isCoarseEvent,
  serializeEvent,
};

export type {
  GatewayEvent,
  InboundEnvelope,
  SessionEventEnvelope,
};
