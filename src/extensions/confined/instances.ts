import { BrokerServer } from './brokerServer';
import { MemoryServer } from './memoryServer';
import { ToolSetServer } from './toolSetServer';

/**
 * Everything a child is serving, by handle.
 *
 * Keyed rather than singular because one extension contributes many: a package
 * with two configured transports and a memory is ordinary, and a child that
 * could hold one of each would have made the boundary narrower than the
 * contract it carries.
 *
 * The handle is the host's, minted where the instance was asked for, and it is
 * the first argument of every method the child answers — which is why the
 * proxies on the other side know nothing about it. They are handed a channel
 * that has already put it there.
 */

type InstanceServer = BrokerServer | MemoryServer | ToolSetServer;

const instances = new Map<string, InstanceServer>();

function keep(handle: string, server: InstanceServer): void {
  if (instances.has(handle)) throw new Error(`Handle "${handle}" is already in use.`);
  instances.set(handle, server);
}

function release(handle: string): void {
  instances.delete(handle);
}

function served<T extends InstanceServer>(
  key: unknown,
  kind: new (...args: never[]) => T,
  what: string,
): T {
  const instance = instances.get(String(key));
  if (!(instance instanceof kind)) {
    throw new Error(`No ${what} is bound to "${String(key)}" in this extension.`);
  }
  return instance;
}

/**
 * Wraps a contributed value in whatever serves its kind.
 *
 * The contribution point decides, because the point is what the host asked for
 * — a value registered under `nox.brokers` is a `Broker` or the package is
 * wrong about itself, and finding that out here is better than finding it out
 * when a message arrives.
 */
function serverFor(point: string, value: unknown): InstanceServer {
  switch (point) {
    case 'nox.brokers':
      return new BrokerServer(value as never);
    case 'nox.memories':
      return new MemoryServer(value as never);
    case 'nox.toolsets':
      return new ToolSetServer(value as never);
    default:
      throw new TypeError(`Contributions to "${point}" cannot cross a process boundary yet.`);
  }
}

export { keep, release, served, serverFor };
export type { InstanceServer };
