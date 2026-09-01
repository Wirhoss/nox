/**
 * What crosses the boundary between Nox and a confined extension.
 *
 * Every message carries an `id` because the boundary is a pipe, not a call
 * stack: several requests are in flight at once and the replies come back in
 * whatever order the work finished. That much is borrowed from the local model
 * worker, which learned it first.
 *
 * What is *not* borrowed is the serialization. This channel is JSON, on
 * purpose: nothing that is not a JSON document may cross. A structured clone
 * would happily carry a `Map`, a `Date` or a cyclic graph, and every one of
 * those would be a live host object appearing inside a package that is
 * supposed to be confined. The contract was reshaped over nine crossings so
 * that nothing needs to — this is where that work is cashed in.
 */

/** The kernel ruleset the child applies to itself before it imports anything. */
interface ConfinementPlan {
  readonly allowances: readonly { readonly path: string; readonly write: boolean }[];
  /**
   * Whether to confine at all. False is the operator's deliberate choice on a
   * kernel that cannot, and the host says so loudly rather than letting it pass
   * as an ordinary start.
   */
  readonly confine: boolean;
}

/** Everything the child needs to exist, passed at spawn rather than sent. */
interface ChildPlan extends ConfinementPlan {
  readonly extensionId: string;
}

/**
 * An error, flattened.
 *
 * The class does not survive and is not recreated on the far side: an
 * extension throwing something the host would `instanceof` is exactly the kind
 * of coupling this boundary exists to remove. The name is kept because it is
 * the one part callers legitimately branch on — `AbortError` in particular.
 */
interface CrossedFailure {
  readonly message: string;
  readonly name: string;
  readonly stack?: string;
}

type HostMessage =
  /**
   * The host's answer to a call the child made. The reverse direction exists
   * for exactly one reason: `BrokerHost` is a set of callbacks a transport
   * makes *into* Nox, and a transport that could only be spoken to would be a
   * transport that cannot deliver anything.
   */
  | { readonly entryPoint: string; readonly id: string; readonly kind: 'load' }
  | { readonly error: CrossedFailure; readonly id: string; readonly kind: 'refused' }
  | { readonly id: string; readonly kind: 'answered'; readonly value: unknown }
  | {
      readonly id: string;
      readonly kind: 'invoke';
      readonly method: string;
      readonly params: readonly unknown[];
    }
  /**
   * Asks the child to exit on its own. Killing it instead would tear it down
   * wherever it happened to be — and a package with an open database
   * transaction is a worse thing to interrupt than to wait a moment for.
   */
  | { readonly kind: 'shutdown' };

type ChildMessage =
  /**
   * A call the other way. Its ids come from the child's own counter and are
   * answered with `answered` or `refused`, so the two directions never share a
   * correlation space and a reply can never be mistaken for a request.
   */
  | { readonly error: CrossedFailure; readonly id: string; readonly kind: 'failed' }
  | {
      readonly fields?: Readonly<Record<string, unknown>>;
      readonly kind: 'log';
      readonly level: 'debug' | 'error' | 'info' | 'warn';
      readonly message: string;
    }
  /**
   * The child has no logger of its own — a confined process cannot open Nox's
   * log file, and should not be able to. Its logging is a message like any
   * other, which also means an extension cannot write a line that does not say
   * which extension wrote it.
   */
  | {
      readonly id: string;
      readonly kind: 'call';
      readonly method: string;
      readonly params: readonly unknown[];
    }
  | { readonly id: string; readonly kind: 'settled'; readonly value: unknown };

/**
 * The one type beyond JSON that crosses, and it crosses named.
 *
 * `MemoryRetainRequest` carries two `Date`s. Sent as-is they arrive as ISO
 * strings — the same shape, the wrong type, and nothing on either side to say
 * so until something calls `.getTime()` on a string weeks later. So a date is
 * tagged on the way out and rebuilt on the way in.
 *
 * This is not structured clone by the back door. What was refused was live host
 * objects: closures, class instances, anything holding a reference into Nox. A
 * date is plain data that JSON happens to have no notation for, it is named in
 * the contract's own types, and the list of exceptions is this one.
 *
 * The cost is that an object with a literal `$date` string key would be
 * misread. That is a shape nothing in the contract has, and the alternative —
 * a codec that walks the type — is a second description of the contract that
 * would drift from it.
 */
const DATE_TAG = '$date';

/** Flattens an error for either direction. The class does not survive; the name does. */
function flattenFailure(cause: unknown): CrossedFailure {
  if (cause instanceof Error) {
    return {
      message: cause.message,
      name: cause.name,
      ...(cause.stack === undefined ? {} : { stack: cause.stack }),
    };
  }
  return { message: String(cause), name: 'Error' };
}

function encodeCrossing(value: unknown): unknown {
  if (value instanceof Date) return { [DATE_TAG]: value.toISOString() };
  if (Array.isArray(value)) return value.map((entry) => encodeCrossing(entry));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, encodeCrossing(entry)]),
    );
  }
  return value;
}

function decodeCrossing(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => decodeCrossing(entry));
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    const tagged = entries.length === 1 && entries[0]?.[0] === DATE_TAG;
    if (tagged && typeof entries[0]?.[1] === 'string') return new Date(entries[0][1]);
    return Object.fromEntries(entries.map(([key, entry]) => [key, decodeCrossing(entry)]));
  }
  return value;
}

export { decodeCrossing, encodeCrossing, flattenFailure };
export type { ChildMessage, ChildPlan, ConfinementPlan, CrossedFailure, HostMessage };
