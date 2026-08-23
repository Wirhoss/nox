import type { MessageContent, ToolResponseExecution } from '../agent/context/message';
import type { ContextUsage } from '../agent/context/options';
import type { RunStatus, RunTrigger } from '../agent/events';
import type { PrincipalRef } from '../auth/principal';
import type { Logger } from '../logger/logger';
import type { Usage } from '../provider/stream';
import type { PermissionRequest, PermissionResolution } from '../tool/gate';
import type { BrokerCommandSpec, CommandInvocation, CommandRejection } from './command';

/**
 * What a broker can render, declared rather than assumed.
 *
 * What a run produces and what a surface shows are different questions, and the
 * second one is the transport's alone: a chat service that can only post text is
 * not the same consumer as a browser with a panel that folds open. So everything
 * a session emits is offered here, and each transport says what it takes. A
 * broker that declares nothing gets the settled reply and nothing else, which is
 * exactly what a bot in a channel wants.
 *
 * Two things are deliberately not on this list, because they are not rendering
 * questions. What another participant said, and which principal was allowed to
 * use which authority, are about who may see what — the gateway keeps those.
 */
interface BrokerCapabilities {
  /**
   * Fold and compaction: the context rewriting itself while a long session runs.
   * A surface that shows a transcript can say what replaced what; a chat cannot.
   */
  readonly contextChanges?: boolean;
  /** The current working-set size and the model window it is filling. */
  readonly contextUsage?: boolean;
  /**
   * The broker can put a permission request in front of its owner and return the
   * answer. The request itself names that owner; the transport only authenticates
   * the sender and renders the prompt.
   */
  readonly permissions?: boolean;
  /**
   * What the model thought on the way to the answer. Settled always, and live
   * too when the broker also streams — a fragment is only useful to a surface
   * that can show a thing being written.
   */
  readonly reasoning?: boolean;
  /** Provider failures that are being retried rather than reported. */
  readonly retries?: boolean;
  /** When a run starts and how it ended — including that it was truncated. */
  readonly runs?: boolean;
  /**
   * The broker can show a reply while it is being written — by editing a message
   * it already sent, or by any other means it has. Without it the conversation
   * only ever sees the settled reply.
   */
  readonly streaming?: boolean;
  /**
   * The session naming itself, once it has been. A surface with a list of
   * conversations has somewhere to put a title; a bot in a channel does not,
   * and the channel is already the name of the conversation there.
   */
  readonly titles?: boolean;
  /** The calls the agent made and what came back from them. */
  readonly toolActivity?: boolean;
  /** Token accounting, per model call and as a run total. */
  readonly usage?: boolean;
}

/** One turn's worth of transport-visible identity: a reply belongs to a run. */
interface OutboundBase {
  readonly conversationId: string;
  /** The run this belongs to. Stable across the fragments and the settled text. */
  readonly turnId: string;
}

/**
 * The context replaced part of itself: a fold standing in for messages that are
 * still in the transcript, or a compaction standing in for a stretch of it. Only
 * `text` is what the model now reads in their place.
 */
interface OutboundContextChange extends OutboundBase {
  readonly change: 'compacted' | 'folded';
  readonly replacedMessageIds: readonly string[];
  readonly text: string;
  readonly type: 'contextChange';
}

/** The bounded context as Nox accounts for it after a change. */
interface OutboundContextUsage extends OutboundBase {
  readonly type: 'contextUsage';
  readonly usage: ContextUsage;
}

/** Something the conversation has to be told about, and no reply is coming. */
interface OutboundError extends OutboundBase {
  readonly text: string;
  readonly type: 'error';
}

/**
 * A piece of a reply that is still being written. Only sent to a broker that
 * declared `streaming`, and never the whole reply — the `message` that follows
 * carries the settled text, which is what a transport should end up showing.
 */
interface OutboundFragment extends OutboundBase {
  readonly text: string;
  readonly type: 'fragment';
}

/** The settled reply. Every broker receives this one. */
interface OutboundMessage extends OutboundBase {
  /** The lossless payload. `text` remains its convenience projection for text transports. */
  readonly content: readonly MessageContent[];
  readonly text: string;
  readonly type: 'message';
}

/**
 * A tool call waiting on a human. The gateway hands over the request as the gate
 * built it; what a transport shows of it — title, preview, risk signals — is the
 * broker's decision, and so is how it collects the answer.
 */
interface OutboundPermission extends OutboundBase {
  readonly request: PermissionRequest;
  readonly type: 'permission';
}

/**
 * A permission that is over, whoever ended it: an answer through this transport,
 * an answer through another surface, a timeout, or an aborted run. A broker that
 * put a prompt in a conversation uses this to retract it.
 */
interface OutboundPermissionResolved extends OutboundBase {
  readonly requestId: string;
  readonly resolution: PermissionResolution;
  readonly type: 'permissionResolved';
}

/** What the model thought, settled. */
interface OutboundReasoning extends OutboundBase {
  readonly text: string;
  readonly type: 'reasoning';
}

/** What the model is thinking, as it arrives. Needs `reasoning` and `streaming`. */
interface OutboundReasoningFragment extends OutboundBase {
  readonly text: string;
  readonly type: 'reasoningFragment';
}

/** A provider call failed and is being tried again. Nothing has gone wrong yet. */
interface OutboundRetry extends OutboundBase {
  readonly attempt: number;
  readonly delayMs: number;
  readonly text: string;
  readonly type: 'retry';
}

/**
 * A run ended. `status` is the part a surface cannot infer on its own: an answer
 * that stopped at `maxIterations` is probably truncated, and one that was
 * `aborted` is not an answer at all.
 *
 * `usage` is here only for a broker that also declared it: the totals belong to
 * the run, but they are token accounting either way.
 */
interface OutboundRunCompleted extends OutboundBase {
  readonly durationMs: number;
  readonly status: RunStatus;
  readonly type: 'runCompleted';
  readonly usage?: Usage;
}

/**
 * A run started. `trigger` is what a surface cannot otherwise tell: a deferred
 * result waking an idle agent looks exactly like a reply to something said.
 */
interface OutboundRunStarted extends OutboundBase {
  readonly modelId: string;
  readonly startedAt: Date;
  readonly trigger: RunTrigger;
  readonly type: 'runStarted';
}

/**
 * The session has a name. It says nothing about the conversation and belongs to
 * no turn in particular — a surface that lists conversations relabels the one
 * this arrived for, and everything already drawn stays as it is.
 */
interface OutboundTitle extends OutboundBase {
  readonly title: string;
  readonly type: 'title';
}

/** A call the agent made. The arguments are the ones it actually sent. */
interface OutboundToolCall extends OutboundBase {
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly trackId: string;
  readonly type: 'toolCall';
}

/**
 * What a call came back with. `execution` says whether this is the result or a
 * placeholder: a `permissionPending` response is the agent being told to wait,
 * and the real result arrives later under the same `trackId`.
 */
interface OutboundToolResponse extends OutboundBase {
  readonly content: readonly MessageContent[];
  readonly execution: ToolResponseExecution;
  readonly isError: boolean;
  readonly name: string;
  readonly text: string;
  readonly trackId: string;
  readonly type: 'toolResponse';
}

/** What one model call cost. The run's total arrives with `runCompleted`. */
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

/**
 * An outbound event minus the addressing the gateway is the one to fill in.
 * Derived rather than restated: a vocabulary this wide, written twice, drifts.
 */
type OutboundBody = OutboundEvent extends infer T
  ? T extends OutboundEvent
    ? Omit<T, 'conversationId' | 'turnId'>
    : never
  : never;

/**
 * The bodies a stored message can become. A run's own events — fragments,
 * retries, usage, a permission that is over — happened around the transcript
 * rather than in it, so nothing here can be read back later.
 */
type MessageBody = Extract<
  OutboundBody,
  { type: 'contextChange' | 'message' | 'reasoning' | 'toolCall' | 'toolResponse' }
>;

/**
 * Something a participant said, which is the one thing a transcript has and the
 * live stream does not. The stream withholds it because who may see what is not
 * a rendering question; reading a conversation back is a different question, and
 * a surface redrawing one it already owns needs both sides of it.
 */
interface HistoryUserMessage {
  readonly content: readonly MessageContent[];
  readonly principal: PrincipalRef;
  readonly text: string;
  readonly type: 'userMessage';
}

/** One entry of a transcript: what was said or done, and where it sits. */
type BrokerHistoryEntry = (HistoryUserMessage | MessageBody) & {
  readonly at: Date;
  readonly messageId: string;
};

interface BrokerHistoryOptions {
  /** Keep only the last N entries. Absent is the whole transcript. */
  readonly limit?: number;
}

/**
 * A conversation read back. `entries` is filtered by the same capabilities the
 * live stream is: a transport that never asked to see tool activity does not
 * start seeing it because it scrolled up.
 */
interface BrokerHistory {
  readonly agentId: string;
  readonly contextUsage?: ContextUsage;
  readonly conversationId: string;
  readonly entries: readonly BrokerHistoryEntry[];
  readonly sessionId: string;
}

/**
 * One conversation bound to this broker. `'closed'` is the ordinary state of a
 * chat nobody has spoken in since the last restart: the binding outlives the
 * process, and the next message reopens the same transcript.
 */
interface BrokerSession {
  readonly agentId: string;
  readonly contextUsage?: ContextUsage;
  readonly conversationId: string;
  readonly sessionId: string;
  /** When the conversation was bound — the first thing ever said in it. */
  readonly startedAt: Date;
  readonly state: 'closed' | 'idle' | 'running';
  /** What the session was named, absent while it has not been. */
  readonly title?: string;
  /** When it was last spoken in. */
  readonly updatedAt: Date;
}

/**
 * What every inbound event names: the chat it belongs to, and the identity the
 * transport authenticated. A sender id asserts who is speaking; it grants
 * nothing, and every question of authority is settled past this point.
 */
interface InboundBase {
  readonly conversationId: string;
  readonly senderId: string;
}

/**
 * Something said into a conversation. `messageId` is the transport's own, used
 * to deduplicate: a delivery retried after a lost acknowledgement is the same
 * thing said once, not a second turn.
 */
interface InboundSpeech extends InboundBase {
  /**
   * Structured content is the canonical ingress. `text` is a compatibility path
   * for text-only brokers and is ignored when `content` is present.
   */
  readonly content?: readonly MessageContent[];
  readonly messageId: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly receivedAt?: Date;
  readonly text?: string;
}

/** Someone said something. It waits its turn if the agent is busy. */
interface InboundMessage extends InboundSpeech {
  readonly type: 'message';
}

/**
 * Someone said something over the top of the run in flight. This is the
 * difference between talking and interrupting: the run is cut short first and
 * what was said becomes the next one, rather than queueing behind an answer that
 * is already going the wrong way. On an idle conversation it is a message.
 */
interface InboundSteer extends InboundSpeech {
  readonly type: 'steer';
}

/**
 * Someone answered a permission request. The gateway checks that the request
 * belongs to the conversation and the Gate checks that the sender is its owner —
 * a transport asserts identity, it does not grant authority.
 */
interface InboundPermission extends InboundBase {
  readonly requestId: string;
  readonly resolution: 'denied' | { readonly approved: 'once' | 'session' };
  readonly type: 'permission';
}

/**
 * Everything a transport hands over that needs no answer. A command is not one
 * of these: it is checked against a schema before it reaches a conversation, and
 * the transport is told when it did not fit.
 */
type InboundEvent = InboundMessage | InboundPermission | InboundSteer;

/**
 * What the gateway hands a broker when it starts it. A concrete broker applies
 * its own channel/sender ingress rules before calling `receive`; rejected traffic
 * is never a kernel event. `receive` returns nothing and never throws: a transport
 * delivering an accepted event is not where a session failure is handled.
 */
interface BrokerHost {
  /**
   * Every command this Nox offers, with the schema of what each one takes. A
   * transport draws a form, fills a palette or registers slash commands from
   * this; it is not a list of things this broker may do, it is the vocabulary
   * itself, and it is the same declaration an invocation is checked against.
   */
  readonly commands: readonly BrokerCommandSpec[];
  readonly logger: Logger;
  readonly signal: AbortSignal;
  /**
   * Invokes a command. It answers whether the invocation was accepted, not what
   * it did: the work queues behind whatever else that conversation has going,
   * exactly like a message, and nothing returns to the caller after that.
   * Nothing is a yes.
   */
  command(invocation: CommandInvocation): CommandRejection | undefined;
  /**
   * One conversation read back, or nothing when this broker never bound that
   * chat. A transcript is not an event: it is asked for and answered, and asking
   * for one neither starts a session nor wakes a closed one.
   */
  history(
    conversationId: string,
    options?: BrokerHistoryOptions,
  ): Promise<BrokerHistory | undefined>;
  receive(event: InboundEvent): void;
  /**
   * Every conversation bound to this broker, most recently spoken in first. Its
   * own only: what another transport is carrying is not this one's to enumerate.
   */
  sessions(): Promise<readonly BrokerSession[]>;
}

/**
 * A transport into the message gateway — Discord, WhatsApp, the browser,
 * anything that carries a conversation. It knows nothing about agents, sessions
 * or the transcript: it delivers what arrived and renders what it is handed. The
 * gateway owns everything between those two, and what "what it is handed" means
 * is the broker's own declaration.
 */
interface Broker {
  readonly capabilities: BrokerCapabilities;
  /** Renders one event. A rejected promise is logged, never fatal to a session. */
  deliver(event: OutboundEvent): Promise<void>;
  start(host: BrokerHost): Promise<void>;
  stop(): Promise<void>;
}

export type {
  Broker,
  BrokerCapabilities,
  BrokerHistory,
  BrokerHistoryEntry,
  BrokerHistoryOptions,
  BrokerHost,
  BrokerSession,
  HistoryUserMessage,
  InboundBase,
  InboundEvent,
  InboundMessage,
  InboundPermission,
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
};
