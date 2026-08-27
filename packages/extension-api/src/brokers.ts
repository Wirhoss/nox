import type { MessageContent, PrincipalRef, ToolResponseExecution } from './content.js';
import type { Logger } from './core.js';
import type { Usage } from './providers.js';
import type { JsonSchema, ToolRisk } from './tools.js';

type RunStatus = 'aborted' | 'completed' | 'failed' | 'maxIterations';
type RunTrigger = 'cron' | 'deferredResult' | 'steer' | 'user';

interface ContextUsage {
  readonly contextWindow?: number;
  readonly compactAtTokens?: number;
  readonly usedTokens: number;
}

interface RiskSignal {
  readonly code: string;
  readonly reason: string;
  readonly resource?: string;
  readonly severity: 'approval' | 'deny' | 'info' | 'review';
}

interface RunAuthority {
  readonly principal: PrincipalRef;
  readonly source:
    | { readonly causeId: string; readonly type: 'system' }
    | { readonly messageId: string; readonly type: 'message' };
}

interface PermissionRequest {
  readonly authority: string;
  readonly expiresAt: Date;
  readonly params: Readonly<Record<string, unknown>>;
  readonly preview?: string;
  readonly reason: string;
  readonly requestId: string;
  readonly requestedAt: Date;
  readonly risk?: ToolRisk;
  readonly runAuthority: RunAuthority;
  readonly runId: string;
  readonly sessionId: string;
  readonly signals: readonly RiskSignal[];
  readonly title: string;
  readonly toolName: string;
  readonly toolSetId: string;
  readonly trackId: string;
}

type PermissionResolution =
  | { readonly resolution: 'aborted' | 'denied' | 'timeout' }
  | { readonly resolution: 'approved'; readonly scope: 'once' | 'session' };

interface BrokerCapabilities {
  readonly contextChanges?: boolean;
  readonly contextUsage?: boolean;
  readonly permissions?: boolean;
  readonly reasoning?: boolean;
  readonly retries?: boolean;
  readonly runs?: boolean;
  readonly streaming?: boolean;
  readonly titles?: boolean;
  readonly toolActivity?: boolean;
  readonly usage?: boolean;
}

interface OutboundBase {
  readonly conversationId: string;
  readonly turnId: string;
}
interface OutboundContextChange extends OutboundBase {
  readonly change: 'compacted' | 'folded';
  readonly replacedMessageIds: readonly string[];
  readonly text: string;
  readonly type: 'contextChange';
}
interface OutboundContextUsage extends OutboundBase {
  readonly type: 'contextUsage';
  readonly usage: ContextUsage;
}
interface OutboundError extends OutboundBase {
  readonly text: string;
  readonly type: 'error';
}
interface OutboundFragment extends OutboundBase {
  readonly text: string;
  readonly type: 'fragment';
}
interface OutboundMessage extends OutboundBase {
  readonly content: readonly MessageContent[];
  readonly text: string;
  readonly type: 'message';
}
interface OutboundPermission extends OutboundBase {
  readonly request: PermissionRequest;
  readonly type: 'permission';
}
interface OutboundPermissionResolved extends OutboundBase {
  readonly requestId: string;
  readonly resolution: PermissionResolution;
  readonly type: 'permissionResolved';
}
interface OutboundReasoning extends OutboundBase {
  readonly text: string;
  readonly type: 'reasoning';
}
interface OutboundReasoningFragment extends OutboundBase {
  readonly text: string;
  readonly type: 'reasoningFragment';
}
interface OutboundRetry extends OutboundBase {
  readonly attempt: number;
  readonly delayMs: number;
  readonly text: string;
  readonly type: 'retry';
}
interface OutboundRunCompleted extends OutboundBase {
  readonly durationMs: number;
  readonly status: RunStatus;
  readonly type: 'runCompleted';
  readonly usage?: Usage;
}
interface OutboundRunStarted extends OutboundBase {
  readonly modelId: string;
  readonly startedAt: Date;
  readonly trigger: RunTrigger;
  readonly type: 'runStarted';
}
interface OutboundTitle extends OutboundBase {
  readonly title: string;
  readonly type: 'title';
}
interface OutboundToolCall extends OutboundBase {
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly trackId: string;
  readonly type: 'toolCall';
}
interface OutboundToolResponse extends OutboundBase {
  readonly content: readonly MessageContent[];
  readonly execution: ToolResponseExecution;
  readonly isError: boolean;
  readonly name: string;
  readonly text: string;
  readonly trackId: string;
  readonly type: 'toolResponse';
}
interface OutboundUsage extends OutboundBase {
  readonly type: 'usage';
  readonly usage: Usage;
}

type OutboundEvent =
  | OutboundContextChange
  | OutboundContextUsage
  | OutboundError
  | OutboundFragment
  | OutboundMessage
  | OutboundPermission
  | OutboundPermissionResolved
  | OutboundReasoning
  | OutboundReasoningFragment
  | OutboundRetry
  | OutboundRunCompleted
  | OutboundRunStarted
  | OutboundTitle
  | OutboundToolCall
  | OutboundToolResponse
  | OutboundUsage;

type OutboundBody = OutboundEvent extends infer T
  ? T extends OutboundEvent
    ? Omit<T, 'conversationId' | 'turnId'>
    : never
  : never;
type MessageBody = Extract<
  OutboundBody,
  { type: 'contextChange' | 'message' | 'reasoning' | 'toolCall' | 'toolResponse' }
>;
interface HistoryUserMessage {
  readonly content: readonly MessageContent[];
  readonly mode: 'message' | 'steer';
  readonly principal: PrincipalRef;
  readonly text: string;
  readonly type: 'userMessage';
}
type BrokerHistoryEntry = (HistoryUserMessage | MessageBody) & {
  readonly at: Date;
  readonly messageId: string;
};

interface BrokerHistoryOptions {
  readonly limit?: number;
}

interface BrokerHistory {
  readonly agentId: string;
  readonly contextUsage?: ContextUsage;
  readonly conversationId: string;
  readonly entries: readonly BrokerHistoryEntry[];
  readonly sessionId: string;
}

interface BrokerSession {
  readonly agentId: string;
  readonly contextUsage?: ContextUsage;
  readonly conversationId: string;
  readonly sessionId: string;
  readonly startedAt: Date;
  readonly state: 'closed' | 'idle' | 'running';
  readonly title?: string;
  readonly updatedAt: Date;
}

interface InboundBase {
  readonly conversationId: string;
  readonly senderId: string;
}
interface InboundSpeech extends InboundBase {
  readonly content: readonly MessageContent[];
  readonly messageId: string;
  readonly requestedAgentId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly receivedAt?: Date;
}
interface InboundMessage extends InboundSpeech {
  readonly type: 'message';
}
interface InboundSteer extends InboundSpeech {
  readonly type: 'steer';
}
interface InboundPermission extends InboundBase {
  readonly requestId: string;
  readonly resolution: 'denied' | { readonly approved: 'once' | 'session' };
  readonly type: 'permission';
}
type InboundEvent = InboundMessage | InboundPermission | InboundSteer;
type InboundRejection =
  | { readonly agentId: string; readonly reason: 'unknownAgent' }
  | { readonly agents: readonly string[]; readonly reason: 'agentRequired' }
  | { readonly reason: 'unavailable' };

interface BrokerCommandSpec {
  readonly description: string;
  readonly name: string;
  readonly parameters: JsonSchema;
}
interface CommandInvocation {
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly command: string;
  readonly conversationId: string;
  readonly senderId: string;
}
type CommandRejection =
  | { readonly detail: string; readonly reason: 'invalidArguments' }
  | { readonly reason: 'unavailable' | 'unknownCommand' };

interface BrokerHost {
  agentIds(): readonly string[];
  readonly defaultAgentId?: string;
  readonly commands: readonly BrokerCommandSpec[];
  readonly logger: Logger;
  readonly signal: AbortSignal;
  command(invocation: CommandInvocation): CommandRejection | undefined;
  history(
    conversationId: string,
    options?: BrokerHistoryOptions,
  ): Promise<BrokerHistory | undefined>;
  receive(event: InboundEvent): InboundRejection | undefined;
  sessions(): Promise<readonly BrokerSession[]>;
}

interface Broker {
  readonly capabilities: BrokerCapabilities;
  deliver(event: OutboundEvent): Promise<void>;
  start(host: BrokerHost): Promise<void>;
  stop(): Promise<void>;
}

export type {
  Broker,
  BrokerCapabilities,
  BrokerCommandSpec,
  BrokerHistory,
  BrokerHistoryEntry,
  BrokerHistoryOptions,
  BrokerHost,
  BrokerSession,
  CommandInvocation,
  CommandRejection,
  ContextUsage,
  HistoryUserMessage,
  InboundBase,
  InboundEvent,
  InboundMessage,
  InboundPermission,
  InboundRejection,
  InboundSpeech,
  InboundSteer,
  MessageBody,
  OutboundBase,
  OutboundBody,
  OutboundContextChange,
  OutboundContextUsage,
  OutboundError,
  OutboundEvent,
  OutboundFragment,
  OutboundMessage,
  OutboundPermission,
  OutboundPermissionResolved,
  OutboundReasoning,
  OutboundReasoningFragment,
  OutboundRetry,
  OutboundRunCompleted,
  OutboundRunStarted,
  OutboundTitle,
  OutboundToolCall,
  OutboundToolResponse,
  OutboundUsage,
  PermissionRequest,
  PermissionResolution,
  RiskSignal,
  RunAuthority,
  RunStatus,
  RunTrigger,
};
