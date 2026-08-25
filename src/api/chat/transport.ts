import type { MessageContent, ToolResponseExecution } from '../../agent/context/message';
import type { RunStatus, RunTrigger } from '../../agent/events';
import type { PrincipalRef } from '../../auth/principal';
import type { Usage } from '../../provider/stream';
import type { RiskSignal } from '../../tool/gate';
import type { ToolRisk } from '../../tool/tool';
import type { JsonSchema } from '../../utils/jsonSchema';

/** One turn's worth of addressing: everything the browser is shown belongs to a run. */
interface ChatEventBase {
  readonly conversationId: string;
  readonly turnId: string;
}

/** Something the conversation has to be told about, and no reply is coming. */
interface ChatErrorEvent extends ChatEventBase {
  readonly text: string;
  readonly type: 'error';
}

/** A piece of a reply still being written. The settled text arrives separately. */
interface ChatFragmentEvent extends ChatEventBase {
  readonly text: string;
  readonly type: 'fragment';
}

/** The settled reply, which is what a client should end up showing. */
interface ChatMessageEvent extends ChatEventBase {
  readonly content: readonly MessageContent[];
  readonly text: string;
  readonly type: 'message';
}

/**
 * A gate request as the browser gets to see it. What crosses is what a person
 * needs in order to answer; the run's authority and the track it belongs to
 * stay inside Nox, because they say who may approve rather than what is being
 * approved, and that question is settled before this is ever sent.
 *
 * Dates are ISO strings: this is the wire, and a `Date` does not survive it.
 */
interface ChatPermissionRequest {
  readonly authority: string;
  readonly expiresAt: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly preview?: string;
  readonly reason: string;
  readonly requestId: string;
  readonly requestedAt: string;
  readonly risk?: ToolRisk;
  readonly runId: string;
  readonly sessionId: string;
  readonly signals: readonly RiskSignal[];
  readonly title: string;
  readonly toolName: string;
  readonly toolSetId: string;
}

/** A tool call waiting on a person. */
interface ChatPermissionEvent extends ChatEventBase {
  readonly request: ChatPermissionRequest;
  readonly type: 'permission';
}

/**
 * How a pending request ended, whoever ended it: an answer from this surface,
 * an answer from another one, a timeout, or an aborted run. A client that drew
 * a prompt uses this to retract it.
 *
 * Flattened rather than mirroring the runtime's discriminated union — `scope`
 * is present only for an approval, and a client reading JSON should not have to
 * narrow twice to find that out.
 */
interface ChatPermissionOutcome {
  readonly resolution: 'aborted' | 'approved' | 'denied' | 'timeout';
  readonly scope?: 'once' | 'session';
}

interface ChatPermissionResolvedEvent extends ChatEventBase {
  readonly outcome: ChatPermissionOutcome;
  readonly requestId: string;
  readonly type: 'permissionResolved';
}

/**
 * The context replaced part of itself: a fold standing in for messages still in
 * the transcript, or a compaction standing in for a stretch of it. A surface
 * that draws a transcript can say what happened to it instead of letting
 * messages quietly change under the reader.
 */
interface ChatContextChangeEvent extends ChatEventBase {
  readonly change: 'compacted' | 'folded';
  readonly replacedMessageIds: readonly string[];
  readonly text: string;
  readonly type: 'contextChange';
}

/** Runtime-owned accounting for the bounded context sent to the model. */
interface ChatContextUsage {
  readonly compactAtTokens?: number;
  readonly contextWindow?: number;
  readonly usedTokens: number;
}

interface ChatContextUsageEvent extends ChatEventBase {
  readonly type: 'contextUsage';
  readonly usage: ChatContextUsage;
}

/** What the model thought, settled. */
interface ChatReasoningEvent extends ChatEventBase {
  readonly text: string;
  readonly type: 'reasoning';
}

/** What the model is thinking, as it arrives. */
interface ChatReasoningFragmentEvent extends ChatEventBase {
  readonly text: string;
  readonly type: 'reasoningFragment';
}

/** A provider call failed and is being tried again. Nothing has gone wrong yet. */
interface ChatRetryEvent extends ChatEventBase {
  readonly attempt: number;
  readonly delayMs: number;
  readonly text: string;
  readonly type: 'retry';
}

/**
 * A run ended. `status` is what a surface cannot infer from the text alone: an
 * answer that stopped at `maxIterations` is probably truncated, and one that was
 * `aborted` is not an answer at all.
 */
interface ChatRunCompletedEvent extends ChatEventBase {
  readonly durationMs: number;
  readonly status: RunStatus;
  readonly type: 'runCompleted';
  readonly usage?: Usage;
}

/**
 * A run started. `trigger` is what a client cannot otherwise tell: a deferred
 * result waking an idle agent looks exactly like a reply to something said.
 */
interface ChatRunStartedEvent extends ChatEventBase {
  readonly modelId: string;
  readonly startedAt: string;
  readonly trigger: RunTrigger;
  readonly type: 'runStarted';
}

/**
 * The session has a name. It belongs to no turn in particular: a client
 * relabels the conversation it names and leaves everything already drawn alone.
 */
interface ChatTitleEvent extends ChatEventBase {
  readonly title: string;
  readonly type: 'title';
}

/** A call the agent made, with the arguments it actually sent. */
interface ChatToolCallEvent extends ChatEventBase {
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly trackId: string;
  readonly type: 'toolCall';
}

/**
 * What a call came back with. `execution` says whether this is the result or a
 * placeholder: `permissionPending` is the agent being told to wait, and the real
 * result arrives later under the same `trackId`.
 */
interface ChatToolResponseEvent extends ChatEventBase {
  readonly content: readonly MessageContent[];
  readonly execution: ToolResponseExecution;
  readonly isError: boolean;
  readonly name: string;
  readonly text: string;
  readonly trackId: string;
  readonly type: 'toolResponse';
}

/** What one model call cost. The run's total arrives with `runCompleted`. */
interface ChatUsageEvent extends ChatEventBase {
  readonly type: 'usage';
  readonly usage: Usage;
}

type ChatEvent =
  | ChatContextChangeEvent
  | ChatContextUsageEvent
  | ChatErrorEvent
  | ChatFragmentEvent
  | ChatMessageEvent
  | ChatPermissionEvent
  | ChatPermissionResolvedEvent
  | ChatReasoningEvent
  | ChatReasoningFragmentEvent
  | ChatRetryEvent
  | ChatRunCompletedEvent
  | ChatRunStartedEvent
  | ChatTitleEvent
  | ChatToolCallEvent
  | ChatToolResponseEvent
  | ChatUsageEvent;

/**
 * A chat event minus the addressing only a live one has. A transcript entry sits
 * in a conversation rather than in a run, and it is read back one whole
 * conversation at a time, so neither id says anything an entry needs.
 */
type ChatBody<T extends ChatEvent> = Omit<T, keyof ChatEventBase>;

/**
 * Something a participant said. It is the one thing a transcript has and the
 * stream does not: the stream never carries what someone else typed, and a
 * conversation redrawn without it would be the agent talking to itself.
 */
interface ChatUserMessage {
  readonly content: readonly MessageContent[];
  readonly principal: PrincipalRef;
  readonly text: string;
  readonly type: 'userMessage';
}

/**
 * One entry of a transcript. Same vocabulary as the stream, so a client draws a
 * conversation it scrolled back to with the code that draws one arriving.
 */
type ChatHistoryEntry = (
  | ChatBody<ChatContextChangeEvent>
  | ChatBody<ChatMessageEvent>
  | ChatBody<ChatReasoningEvent>
  | ChatBody<ChatToolCallEvent>
  | ChatBody<ChatToolResponseEvent>
  | ChatUserMessage
) & {
  /** When it was appended, ISO. */
  readonly at: string;
  readonly messageId: string;
};

/** A conversation read back, filtered to what this surface is allowed to show. */
interface ChatHistory {
  readonly agentId: string;
  readonly contextUsage?: ChatContextUsage;
  readonly conversationId: string;
  readonly entries: readonly ChatHistoryEntry[];
  readonly sessionId: string;
}

/**
 * One conversation this surface carries. `'closed'` is the ordinary state after
 * a restart: the binding outlives the process, and the next message reopens the
 * same transcript rather than starting the chat over.
 */
interface ChatConversation {
  readonly agentId: string;
  readonly contextUsage?: ChatContextUsage;
  readonly conversationId: string;
  readonly sessionId: string;
  readonly startedAt: string;
  readonly state: 'closed' | 'idle' | 'running';
  /** What the session was named, absent while it has not been. */
  readonly title?: string;
  readonly updatedAt: string;
}

/** One rendered event and its monotonic cursor on this transport instance. */
type ChatListener = (event: ChatEvent, eventId: number) => void;

interface ChatSubscriptionOptions {
  /** Replays events after this cursor before following live delivery. */
  readonly afterEventId?: number;
}

/** An answer to a pending request, as a client states it. */
interface ChatDecisionInput {
  readonly conversationId: string;
  readonly decision: 'approve' | 'deny';
  readonly requestId: string;
  /** Only meaningful for an approval; a denial has no scope to remember. */
  readonly scope?: 'once' | 'session';
  /** Who the surface authenticated. It asserts identity; it does not grant authority. */
  readonly senderId: string;
}

/** Something a person said. `messageId` is this surface's own, used to deduplicate. */
interface ChatMessageInput {
  readonly content: readonly MessageContent[];
  readonly conversationId: string;
  readonly messageId: string;
  readonly senderId: string;
  /** Convenience projection for clients and text-only transports. */
  readonly text: string;
}

/** How much of a conversation to read back. */
interface ChatHistoryInput {
  readonly conversationId: string;
  /** Keep only the last N entries. Absent is the whole transcript. */
  readonly limit?: number;
}

/**
 * A command this surface offers, and the shape of what it takes. A client draws
 * a form, fills a palette or builds a slash command out of `parameters`, which
 * is JSON Schema — so a list, a multiple choice or a nested object needs nothing
 * added here to be rendered, and nothing added here to be checked.
 */
interface ChatCommand {
  readonly description: string;
  readonly name: string;
  readonly parameters: JsonSchema;
}

/** One invocation, as a client states it. */
interface ChatCommandInput {
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly command: string;
  readonly conversationId: string;
  /** Who the surface authenticated. It asserts identity; it does not grant authority. */
  readonly senderId: string;
}

/**
 * Why an invocation never reached the conversation, in the terms an HTTP client
 * needs: the two a caller can fix, and the one that means come back later.
 */
type ChatCommandRejection =
  | { readonly detail: string; readonly reason: 'invalidArguments' }
  | { readonly reason: 'unavailable' }
  | { readonly reason: 'unknownCommand' };

/**
 * What the chat routes need of whatever carries the conversation. It is stated
 * here, where it is consumed, rather than imported from the transport that
 * happens to satisfy it: the HTTP surface is allowed to say what it requires,
 * and it is not allowed to know which broker turned up.
 *
 * Nothing here reaches a session. Submitting hands an event to the transport,
 * which is where the runtime's own rules take over.
 */
interface ChatTransport {
  /** Every conversation this surface carries, most recently spoken in first. */
  listConversations(): Promise<readonly ChatConversation[]>;
  /** Every command it offers, with the schema of what each one takes. */
  listCommands(): readonly ChatCommand[];
  /**
   * One conversation read back, or nothing when this surface never carried it.
   * Reading is not speaking: it opens no session and wakes no closed one.
   */
  readHistory(input: ChatHistoryInput): Promise<ChatHistory | undefined>;
  /**
   * Invokes a command. It answers why the invocation was refused, or nothing
   * when it was accepted — accepted meaning queued, not finished.
   */
  submitCommand(input: ChatCommandInput): ChatCommandRejection | undefined;
  submitDecision(input: ChatDecisionInput): void;
  submitMessage(input: ChatMessageInput): void;
  /** Says something over the top of the run in flight, rather than after it. */
  submitSteer(input: ChatMessageInput): void;
  /** Everything the transport renders, until the returned function is called. */
  subscribe(listener: ChatListener, options?: ChatSubscriptionOptions): () => void;
}

/**
 * Where the chat routes find Nox's internal web transport.
 *
 * Bootstrap attaches exactly one before the API listens. The empty state still
 * exists for construction and shutdown, and routes report it as temporary
 * unavailability rather than as missing deployment configuration.
 */
class ChatHub {
  #transport: ChatTransport | undefined;

  public get transport(): ChatTransport | undefined {
    return this.#transport;
  }

  /** Attaches until the returned function is called; the HTTP surface has exactly one slot. */
  public attach(transport: ChatTransport): () => void {
    if (this.#transport !== undefined) {
      throw new Error('The HTTP chat surface already has its internal transport attached.');
    }
    this.#transport = transport;

    return (): void => {
      if (this.#transport === transport) this.#transport = undefined;
    };
  }
}

export { ChatHub };

export type {
  ChatBody,
  ChatCommand,
  ChatCommandInput,
  ChatCommandRejection,
  ChatContextChangeEvent,
  ChatContextUsage,
  ChatContextUsageEvent,
  ChatConversation,
  ChatDecisionInput,
  ChatErrorEvent,
  ChatEvent,
  ChatFragmentEvent,
  ChatHistory,
  ChatHistoryEntry,
  ChatHistoryInput,
  ChatListener,
  ChatMessageEvent,
  ChatMessageInput,
  ChatPermissionEvent,
  ChatPermissionOutcome,
  ChatPermissionRequest,
  ChatPermissionResolvedEvent,
  ChatReasoningEvent,
  ChatReasoningFragmentEvent,
  ChatRetryEvent,
  ChatRunCompletedEvent,
  ChatRunStartedEvent,
  ChatSubscriptionOptions,
  ChatTitleEvent,
  ChatToolCallEvent,
  ChatToolResponseEvent,
  ChatTransport,
  ChatUsageEvent,
  ChatUserMessage,
};
