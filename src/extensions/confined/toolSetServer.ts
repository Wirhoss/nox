import type {
  MessageContent,
  PreparedToolCall,
  ToolContext,
  ToolDeclaration,
  ToolSet,
} from '@nox/extension-api';

/**
 * The child's half of a tool set: it holds the real `ToolSet` and answers for
 * it one message at a time.
 *
 * A prepared call cannot cross — it is a record with a closure on it — so it is
 * split where the contract already splits it. The descriptive half is data and
 * goes back immediately; the closure stays here under an id, and `run` is a
 * second message naming that id. That split is not invented for the transport:
 * `PreparedToolCall` was shaped this way precisely so a transport could be
 * built from it.
 */

/** What a prepared call looks like once the closure has been left behind. */
interface CrossedPreparation {
  readonly callId: string;
  readonly gateSubject?: PreparedToolCall['gateSubject'];
  readonly params: Readonly<Record<string, unknown>>;
  readonly preview?: string;
  readonly risk?: PreparedToolCall['risk'];
  readonly title: string;
  readonly type: 'deferred' | 'immediate';
}

/** A deferred call's second half, still running here after its ack went back. */
interface Held {
  readonly abort: AbortController;
  readonly prepared: PreparedToolCall;
  result?: Promise<MessageContent[]>;
}

/**
 * The context an extension sees inside the child.
 *
 * Only what a JSON document can carry. Everything a host would have hung on it
 * — the artifact reader, the publisher, the response attacher — is a live
 * object belonging to Nox, and a boundary that let those through would be a
 * boundary in name only. A tool that needs one asks over the channel, which is
 * the next thing to build; until then it is absent rather than faked, so a set
 * that depends on one fails where it is used instead of silently doing nothing.
 */
interface CrossedContext {
  readonly session?: ToolContext['session'];
  readonly toolSetId?: string;
}

let nextCallId = 0;

class ToolSetServer {
  readonly #held = new Map<string, Held>();
  readonly #toolSet: ToolSet;

  constructor(toolSet: ToolSet) {
    this.#toolSet = toolSet;
  }

  public declarations(): Readonly<Record<string, ToolDeclaration>> {
    return this.#toolSet.declarations;
  }

  public describe(): { readonly description: string; readonly name: string } {
    return { description: this.#toolSet.description, name: this.#toolSet.name };
  }

  public async prepare(name: string, rawParams: unknown): Promise<CrossedPreparation> {
    const prepared = await this.#toolSet.prepare(name, rawParams);
    const callId = `tool-${String(++nextCallId)}`;
    this.#held.set(callId, { abort: new AbortController(), prepared });
    return {
      callId,
      ...(prepared.gateSubject === undefined ? {} : { gateSubject: prepared.gateSubject }),
      params: prepared.params,
      ...(prepared.preview === undefined ? {} : { preview: prepared.preview }),
      ...(prepared.risk === undefined ? {} : { risk: prepared.risk }),
      title: prepared.title,
      type: prepared.type,
    };
  }

  /** An immediate call: one message in, the whole answer out. */
  public async run(callId: string, context: CrossedContext): Promise<MessageContent[]> {
    const held = this.#take(callId);
    if (held.prepared.type !== 'immediate') {
      throw new TypeError(`Call ${callId} is deferred; ask for its acknowledgement instead.`);
    }
    try {
      return await held.prepared.run(this.#context(held, context));
    } finally {
      this.#held.delete(callId);
    }
  }

  /**
   * A deferred call's acknowledgement. The result keeps running here and is
   * collected by {@link result} — one call, two messages, because that is what
   * a deferred execution is on either side of the boundary.
   */
  public async acknowledge(callId: string, context: CrossedContext): Promise<MessageContent[]> {
    const held = this.#take(callId);
    if (held.prepared.type !== 'deferred') {
      throw new TypeError(`Call ${callId} is immediate; run it instead.`);
    }
    const { ack, result } = await held.prepared.run(this.#context(held, context));
    // Held, not awaited: the point of a deferred call is that the ack returns
    // while the work continues. An unobserved rejection here would be an
    // unhandled rejection in the child, so it is parked with a catch that the
    // real `result` call re-throws.
    held.result = result;
    result.catch(() => undefined);
    return ack;
  }

  public async result(callId: string): Promise<MessageContent[]> {
    const held = this.#take(callId);
    if (held.result === undefined) throw new Error(`Call ${callId} has not been acknowledged.`);
    try {
      return await held.result;
    } finally {
      this.#held.delete(callId);
    }
  }

  /**
   * Cancellation is a message of its own, because an `AbortSignal` does not
   * survive a JSON document — the host has to say out loud which call it no
   * longer wants, and the signal the tool sees is created on this side.
   */
  public abort(callId: string): void {
    this.#held.get(callId)?.abort.abort();
  }

  #context(held: Held, context: CrossedContext): ToolContext {
    return {
      abortSignal: held.abort.signal,
      ...(context.session === undefined ? {} : { session: context.session }),
      ...(context.toolSetId === undefined ? {} : { toolSetId: context.toolSetId }),
    };
  }

  #take(callId: string): Held {
    const held = this.#held.get(callId);
    if (held === undefined) throw new Error(`Call ${callId} is not prepared, or is already done.`);
    return held;
  }
}

export { ToolSetServer };
export type { CrossedContext, CrossedPreparation };
