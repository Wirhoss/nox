/*
 * Domain types mirroring the Nox gateway wire format.
 *
 * These describe what the REST routes and the SSE stream actually send. They
 * are the contract the Playground is built on; keep them in step with
 * `src/server/routes/sessions.ts` and the provider message types.
 */

type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { kind: 'url'; url: string } | { kind: 'base64'; mediaType: string; data: string } };

type Message =
  | { role: 'user' | 'assistant' | 'reasoning'; content: Content[] }
  | { role: 'toolCall'; name: string; trackId: string; arguments: Record<string, unknown> }
  | {
    role: 'toolResponse';
    name: string;
    trackId: string;
    execution: 'immediate' | 'deferredAck' | 'deferredResult';
    response: Content[];
    isError?: boolean;
  };

/** A message that carries prose, as opposed to a tool call or its response. */
type TextMessage = Extract<Message, { role: 'user' | 'assistant' | 'reasoning' }>;
type ToolCallMessage = Extract<Message, { role: 'toolCall' }>;
type ToolResponseMessage = Extract<Message, { role: 'toolResponse' }>;

type Blueprint = {
  id: string;
  description: string;
  systemPrompt: string;
  coreTools: string[];
  lazyLoadedTools: string[];
  config: { providerId: string; modelId: string; maxIterations: number };
};

type CollaborationStatus = 'draft' | 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';

type DeepResearch = {
  researchId: string;
  title: string;
  objective: string;
  status: CollaborationStatus;
  createdAt: string | number;
  updatedAt: string | number;
};

type CreateDeepResearch = Pick<DeepResearch, 'objective' | 'title'>;

type Deliberation = {
  deliberationId: string;
  title: string;
  question: string;
  participantBlueprintIds: string[];
  moderatorBlueprintId: string | null;
  rounds: number;
  currentRound: number;
  status: CollaborationStatus;
  consensusReached: boolean;
  terminationReason: 'consensus' | 'max_rounds' | null;
  finalReport: string | null;
  error: string | null;
  startedAt: string | number | null;
  completedAt: string | number | null;
  createdAt: string | number;
  updatedAt: string | number;
};

type DeliberationTurn = {
  turnId: number;
  deliberationId: string;
  round: number;
  phase: 'proposal' | 'critique' | 'consensus' | 'synthesis';
  blueprintId: string;
  sessionId: string;
  content: string;
  createdAt: string | number;
};

type DeliberationDetail = Deliberation & { turns: DeliberationTurn[] };
type DeliberationConfiguration = Pick<Deliberation, 'moderatorBlueprintId' | 'participantBlueprintIds' | 'rounds'> & {
  moderatorBlueprintId: string;
};
type CreateDeliberation = Pick<Deliberation, 'question' | 'title' | 'participantBlueprintIds' | 'rounds'> & {
  moderatorBlueprintId: string;
};

type SessionSummary = {
  sessionId: string;
  blueprintId: string;
  createdAt: string | number;
  updatedAt: string | number;
};

/**
 * A row from `/api/v1/sessions`, which joins each session to its run statistics.
 * Callers that only need identity read it as a `SessionSummary`.
 */
type SessionListEntry = SessionSummary & {
  latestRun: RunSummary | null;
  runCount: number;
  usage: RunUsage;
};

type RunStatus = 'running' | 'completed' | 'aborted' | 'maxIterations' | 'failed';
type RunUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number };

/*
 * Timestamps are typed `string | number` throughout: the gateway sends ISO
 * strings from its own routes but second-precision epoch numbers wherever the
 * value comes straight out of SQLite. `toDate` in `format.ts` normalises both.
 */
type RunSummary = {
  runId: string;
  modelId: string | null;
  status: RunStatus;
  startedAt: string | number;
  completedAt: string | number | null;
  durationMs: number | null;
  usage: RunUsage;
};

/** A run as listed by `/api/v1/runs`, joined to the session that produced it. */
type Run = RunSummary & { blueprintId: string; sessionId: string };

/**
 * The full response of `GET /api/v1/sessions/:sessionId`.
 *
 * The Playground and the Sessions workbench read the same payload — the former
 * for live state, the latter for inspection — so there is one type for both.
 */
type SessionSnapshot = {
  activityCount: number;
  eventCursor: number;
  isRunning: boolean;
  latestRun: RunSummary | null;
  /** Parallel to `messages`, carrying the stored timestamps. */
  messageEntries: Array<{ createdAt: string | number; message: Message; position: number }>;
  messages: Message[];
  recentActivities: SnapshotActivity[];
  runs: RunSummary[];
  session: SessionSummary;
};

type Permission = {
  requestId: string;
  toolName: string;
  toolArguments: Record<string, unknown>;
  reason: string;
};

/* ------------------------------------------------------------------ providers */

type ModelConfig = { modelId: string; type: string; contextWindow?: number };

/**
 * A configured model endpoint. `hasApiKey` stands in for the credential itself,
 * which the gateway redacts on every read.
 */
type Provider = {
  id: string;
  type: 'openai_completions';
  status: 'active' | 'inactive';
  baseUrl: string;
  hasApiKey: boolean;
  defaultModel?: string;
  timeoutMs?: number;
  modelConfigs?: ModelConfig[];
};

/** Provider writes report whether the change needs a restart to take effect. */
type ProviderMutation = { provider: Provider; restartRequired: boolean };

/* ----------------------------------------------------------------------- logs */

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

type LogEntry = {
  context: Record<string, unknown>;
  id: number;
  level: LogLevel;
  message: string;
  module: string | null;
  timestamp: string;
};

/** `dropped` counts entries the ring buffer evicted before they were read. */
type LogResponse = { dropped: number; items: LogEntry[]; modules: string[]; total: number };

/* ------------------------------------------------------------------- settings */

/** A gate policy: which calls it covers, and what happens when it matches. */
type GateRule = {
  tools: '*' | string[];
  /** Argument name to regular-expression source; all entries must match. */
  match?: Record<string, string>;
  verdict: 'deny' | 'escalate';
  reason: string;
};

type GateConfig = { rules: GateRule[]; escalationTimeoutMs: number };
type GateMutation = { gate: GateConfig; restartRequired: boolean };

/**
 * One input in a service-supplied settings schema. The gateway describes its
 * configurable fields this way so the UI can render them without knowing the
 * service; `name` is a dot path into the config object.
 */
type SettingsField = {
  defaultValue?: boolean | number | string;
  help?: string;
  label: string;
  maximum?: number;
  minimum?: number;
  name: string;
  required?: boolean;
  secret?: boolean;
  type: 'boolean' | 'number' | 'text' | 'url';
};

/** A selectable service, split into how it connects and what agents may pass. */
type ServiceDefinition = {
  id: string;
  label: string;
  serviceFields: SettingsField[];
  contractFields: SettingsField[];
};

type CapabilityConfig = {
  service: string;
  serviceConfig: Record<string, unknown>;
  contract: Record<string, unknown>;
  hasApiKey?: boolean;
};

type CapabilityKind = 'web_search' | 'web_extract';
type WebToolsConfig = Partial<Record<CapabilityKind, CapabilityConfig>>;

type WebToolsResponse = {
  config: WebToolsConfig;
  services: Record<CapabilityKind, ServiceDefinition[]>;
  restartRequired?: boolean;
};

type GatewayEvent =
  | { type: 'assistantTextFragment'; text: string }
  | { type: 'assistantReasoningFragment'; text: string }
  | { type: 'error'; message: string }
  | { type: 'message'; message: Message }
  | { type: 'permissionRequest'; requestId: string; toolName: string; toolArguments: Record<string, unknown>; reason: string }
  | { type: 'permissionResolved'; requestId: string; resolution: 'approved' | 'denied' | 'timeout' | 'aborted' }
  | { type: 'runStarted'; runId: string; modelId: string; startedAt: string }
  | { type: 'runCompleted'; runId: string; status: Exclude<RunStatus, 'running'>; durationMs: number; usage: RunUsage };

/**
 * Everything except the token fragments. Fragments arrive per-token and would
 * swamp the activity feed, so only these are retained as discrete events.
 */
type ActivityEvent = Exclude<GatewayEvent, { type: 'assistantReasoningFragment' | 'assistantTextFragment' }>;

/** An activity as the gateway sends it, before `receivedAt` is parsed. */
type SnapshotActivity = { cursor: number; event: ActivityEvent; receivedAt: string };

/** An activity held in memory, with `receivedAt` resolved to a Date. */
type Activity = { cursor: number; event: ActivityEvent; receivedAt: Date };

/** The SSE event names the gateway emits, used to register stream listeners. */
const GATEWAY_EVENT_NAMES = [
  'assistantTextFragment',
  'assistantReasoningFragment',
  'message',
  'permissionRequest',
  'permissionResolved',
  'runStarted',
  'runCompleted',
] as const;

export {
  GATEWAY_EVENT_NAMES,
};

export type {
  Activity,
  ActivityEvent,
  Blueprint,
  CapabilityConfig,
  CapabilityKind,
  CollaborationStatus,
  Content,
  CreateDeepResearch,
  CreateDeliberation,
  DeepResearch,
  GateConfig,
  GateMutation,
  GateRule,
  GatewayEvent,
  Deliberation,
  DeliberationConfiguration,
  DeliberationDetail,
  DeliberationTurn,
  LogEntry,
  LogLevel,
  LogResponse,
  Message,
  ModelConfig,
  Permission,
  Provider,
  ProviderMutation,
  Run,
  RunStatus,
  RunSummary,
  RunUsage,
  ServiceDefinition,
  SessionListEntry,
  SessionSnapshot,
  SessionSummary,
  SettingsField,
  SnapshotActivity,
  TextMessage,
  ToolCallMessage,
  ToolResponseMessage,
  WebToolsConfig,
  WebToolsResponse,
};
