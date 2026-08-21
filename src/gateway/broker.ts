import type { Logger } from '../logger/logger';
import type { PermissionRequest, PermissionResolution } from '../tool/gate';

/**
 * What a broker can do beyond carrying text, declared rather than assumed. The
 * gateway sends a transport only what that transport says it can render: a
 * broker that cannot edit a message never receives the fragments of a reply
 * still being written, and one that cannot ask a human for an answer never
 * receives a permission request it would have to drop.
 */
interface BrokerCapabilities {
  /**
   * The broker can put a permission request in front of a human and return the
   * answer. Prompts are still only delivered to a broker whose configuration
   * names who may answer them.
   */
  readonly permissions?: boolean;
  /**
   * The broker can show a reply while it is being written — by editing a message
   * it already sent, or by any other means it has. Without it the conversation
   * only ever sees the settled reply.
   */
  readonly streaming?: boolean;
}

/** One turn's worth of transport-visible identity: a reply belongs to a run. */
interface OutboundBase {
  readonly conversationId: string;
  /** The run this belongs to. Stable across the fragments and the settled text. */
  readonly turnId: string;
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

/** Something the conversation has to be told about, and no reply is coming. */
interface OutboundError extends OutboundBase {
  readonly text: string;
  readonly type: 'error';
}

type OutboundEvent =
  | OutboundError
  | OutboundFragment
  | OutboundMessage
  | OutboundPermission
  | OutboundPermissionResolved;

/** Someone said something. `messageId` is the transport's own, used to deduplicate. */
interface InboundMessage {
  readonly conversationId: string;
  readonly messageId: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly receivedAt?: Date;
  readonly senderId: string;
  readonly text: string;
  readonly type: 'message';
}

/**
 * Someone answered a permission request. The gateway checks that the sender is
 * one the broker's configuration named as an approver, and that the request
 * belongs to the conversation it arrived in — a transport asserts identity, it
 * does not grant authority.
 */
interface InboundPermission {
  readonly conversationId: string;
  readonly requestId: string;
  readonly resolution: 'denied' | { readonly approved: 'once' | 'session' };
  readonly senderId: string;
  readonly type: 'permission';
}

type InboundEvent = InboundMessage | InboundPermission;

/**
 * What the gateway hands a broker when it starts it. `receive` returns nothing
 * and never throws: a transport delivering an event is not the place where a
 * session's failure is handled, and the gateway is the one holding the queue.
 */
interface BrokerHost {
  readonly logger: Logger;
  readonly signal: AbortSignal;
  receive(event: InboundEvent): void;
}

/**
 * A transport into the message gateway — Discord, WhatsApp, anything that
 * carries a conversation. It knows nothing about agents, sessions or the
 * transcript: it delivers what arrived and renders what it is handed. The
 * gateway owns everything between those two.
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
  BrokerHost,
  InboundEvent,
  InboundMessage,
  InboundPermission,
  OutboundError,
  OutboundEvent,
  OutboundFragment,
  OutboundMessage,
  OutboundPermission,
  OutboundPermissionResolved,
};
