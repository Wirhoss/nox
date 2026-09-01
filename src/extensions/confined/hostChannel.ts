import { decodeCrossing, encodeCrossing } from './protocol';

import type { ChildMessage, HostMessage } from './protocol';

/**
 * The child's side of the channel, as anything inside the child may use it.
 *
 * Separate from `child.ts` because the servers need it too: a broker's
 * `BrokerHost` is a set of callbacks into Nox, and the code that builds those
 * callbacks has no business also owning the process's message loop.
 *
 * Its ids come from a counter of their own. The two directions never share a
 * correlation space, so a reply can never be mistaken for a request.
 */

interface Pending {
  readonly reject: (error: Error) => void;
  readonly resolve: (value: unknown) => void;
}

const awaiting = new Map<string, Pending>();
let nextId = 0;

function send(message: ChildMessage): void {
  process.send?.(message);
}

async function callHost(method: string, ...params: readonly unknown[]): Promise<unknown> {
  const id = `host-${String(++nextId)}`;
  const settled = new Promise<unknown>((resolve, reject) => {
    awaiting.set(id, { reject, resolve });
  });
  try {
    send({ id, kind: 'call', method, params: params.map((param) => encodeCrossing(param)) });
    return await settled;
  } finally {
    awaiting.delete(id);
  }
}

/** The half of `HostMessage` that answers, as opposed to asking for something. */
type HostAnswer = Extract<HostMessage, { kind: 'answered' | 'refused' }>;

/** True when the message was an answer to one of ours, and has been dealt with. */
function settleHostAnswer(message: HostMessage): message is HostAnswer {
  if (message.kind !== 'answered' && message.kind !== 'refused') return false;
  const pending = awaiting.get(message.id);
  if (pending === undefined) return true;
  awaiting.delete(message.id);
  if (message.kind === 'answered') {
    pending.resolve(decodeCrossing(message.value));
    return true;
  }
  // The class does not survive; the name does, because it is the one part a
  // caller legitimately branches on.
  const error = new Error(message.error.message);
  error.name = message.error.name;
  pending.reject(error);
  return true;
}

/** Rejects everything still waiting, for when the host is going away. */
function abandonHostCalls(reason: string): void {
  for (const [id, pending] of [...awaiting]) {
    awaiting.delete(id);
    pending.reject(new Error(reason));
  }
}

export { abandonHostCalls, callHost, send, settleHostAnswer };
export type { HostAnswer };
