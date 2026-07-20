import { AgentRegistry } from '../agent/registry';
import { createLogger } from '../logger';

import { SessionDispatcher } from './dispatcher';
import { isCoarseEvent, serializeEvent } from './events';

import type { PendingEscalation } from '../gate';
import type { Message } from '../provider';
import type { BaseBroker, GatewayInbox } from './broker';
import type { GatewaySession } from './dispatcher';
import type { InboundEnvelope, SessionEventEnvelope } from './events';

const logger = createLogger('gateway');

interface SessionResolver {
  createSession(blueprintId: string): { session: GatewaySession; sessionId: string };
  restoreSession(sessionId: string): GatewaySession;
  deleteSession(sessionId: string): Promise<void>;
}

class MessageGateway {
  private static _instance: MessageGateway;

  private readonly resolver: SessionResolver;
  private readonly dispatchers = new Map<string, SessionDispatcher>();
  // TODO: persist bindings once the first external broker lands; in-memory
  // bindings die with the process while sessions survive in SQLite.
  private readonly bindings = new Map<string, string>();

  constructor(resolver: SessionResolver) {
    this.resolver = resolver;
  }

  public static get instance(): MessageGateway {
    if (!MessageGateway._instance) {
      MessageGateway._instance = new MessageGateway(AgentRegistry.instance);
    }
    return MessageGateway._instance;
  }

  public createSession(blueprintId: string): { sessionId: string } {
    const { sessionId } = this.resolver.createSession(blueprintId);
    return { sessionId };
  }

  public getHistory(sessionId: string): { eventCursor: number; messages: readonly Message[] } {
    const session = this.resolver.restoreSession(sessionId);
    return { eventCursor: session.eventCursor, messages: session.history };
  }

  public sendMessage(sessionId: string, text: string, opts?: { steer?: boolean }): { delivery: 'queued' | 'steered' } {
    const session = this.resolver.restoreSession(sessionId);
    const delivery = this.dispatcherFor(sessionId, session).submit(text, opts?.steer ?? false);
    return { delivery };
  }

  public async abortRun(sessionId: string): Promise<{ aborted: boolean }> {
    const session = this.resolver.restoreSession(sessionId);
    this.dispatchers.get(sessionId)?.clearPending();
    const aborted = await session.abort();
    return { aborted };
  }

  public async deleteSession(sessionId: string): Promise<void> {
    this.dispatchers.get(sessionId)?.clearPending();
    this.dispatchers.delete(sessionId);
    for (const [key, boundSessionId] of this.bindings) {
      if (boundSessionId === sessionId) {
        this.bindings.delete(key);
      }
    }
    await this.resolver.deleteSession(sessionId);
  }

  public listPendingPermissions(sessionId: string): PendingEscalation[] {
    return this.resolver.restoreSession(sessionId).listPendingPermissions();
  }

  public subscribe(sessionId: string, from = 0): AsyncGenerator<SessionEventEnvelope> {
    const session = this.resolver.restoreSession(sessionId);
    return this.streamEvents(session, from);
  }

  public createInbox(brokerId: string, broker: BaseBroker): GatewayInbox {
    return {
      openConversation: (conversationId, blueprintId) => {
        const { sessionId } = this.resolver.createSession(blueprintId ?? broker.defaultBlueprintId);
        this.bindings.set(bindingKey(brokerId, conversationId), sessionId);
        this.startOutboundPump(brokerId, broker, conversationId, sessionId);
        return { sessionId };
      },
      submit: (conversationId, envelope) => {
        this.submitToConversation(brokerId, broker, conversationId, envelope);
      },
    };
  }

  private submitToConversation(brokerId: string, broker: BaseBroker, conversationId: string, envelope: InboundEnvelope): void {
    const sessionId = this.bindings.get(bindingKey(brokerId, conversationId));
    if (!sessionId) {
      throw new Error(`No session bound to conversation ${conversationId} on broker ${brokerId}.`);
    }
    if (envelope.kind === 'control') {
      this.handleControl(brokerId, conversationId, sessionId, envelope);
      return;
    }
    const session = this.resolver.restoreSession(sessionId);
    this.dispatcherFor(sessionId, session, broker.debounceMs).submit(envelope.text, envelope.steer ?? false);
  }

  private handleControl(brokerId: string, conversationId: string, sessionId: string, envelope: Extract<InboundEnvelope, { kind: 'control' }>): void {
    if (envelope.action !== 'permissionReply') {
      logger.warn({ brokerId, conversationId, action: envelope.action }, 'Unknown control action, dropping.');
      return;
    }
    const requestId = envelope.payload?.['requestId'];
    const approved = envelope.payload?.['approved'];
    if (typeof requestId !== 'string' || typeof approved !== 'boolean') {
      logger.warn({ brokerId, conversationId }, 'Malformed permissionReply payload, dropping.');
      return;
    }
    const resolved = this.resolvePermission(sessionId, requestId, approved);
    if (!resolved) {
      logger.warn({ brokerId, conversationId, requestId }, 'permissionReply for unknown or already resolved request.');
    }
  }

  public resolvePermission(sessionId: string, requestId: string, approved: boolean): boolean {
    const session = this.resolver.restoreSession(sessionId);
    return session.resolvePermission(requestId, approved);
  }

  private dispatcherFor(sessionId: string, session: GatewaySession, debounceMs?: number): SessionDispatcher {
    let dispatcher = this.dispatchers.get(sessionId);
    if (!dispatcher) {
      const onError = (error: Error) => {
        logger.error({ err: error, sessionId }, 'Agent run failed after message dispatch.');
      };
      dispatcher = new SessionDispatcher(session, onError, debounceMs);
      this.dispatchers.set(sessionId, dispatcher);
    }
    return dispatcher;
  }

  private async *streamEvents(session: GatewaySession, from: number): AsyncGenerator<SessionEventEnvelope> {
    const start = from > session.eventCursor ? 0 : from;
    let cursor = start;
    for await (const event of session.subscribeToEvents(start)) {
      yield { cursor: cursor++, event: serializeEvent(event) };
    }
  }

  private startOutboundPump(brokerId: string, broker: BaseBroker, conversationId: string, sessionId: string): void {
    void (async () => {
      try {
        for await (const envelope of this.subscribe(sessionId)) {
          if (broker.delivery === 'messages' && !isCoarseEvent(envelope.event)) {
            continue;
          }
          try {
            await broker.deliver(conversationId, envelope);
          } catch (error) {
            logger.error({ err: error, brokerId, conversationId, sessionId }, 'Broker delivery failed.');
          }
        }
      } catch (error) {
        logger.error({ err: error, brokerId, conversationId, sessionId }, 'Outbound pump crashed.');
      }
    })();
  }
}

function bindingKey(brokerId: string, conversationId: string): string {
  return `${brokerId}:${conversationId}`;
}

export {
  MessageGateway,
};

export type {
  SessionResolver,
};
