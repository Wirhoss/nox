/**
 * The far side of the boundary: a process that confines itself, then loads one
 * extension and answers for it.
 *
 * The order of the first few statements is the entire security property. The
 * ruleset arrives as an argument rather than as a message, because a message
 * would arrive after this module was already running — leaving a window, however
 * short, in which an unconfined process was executing code on an extension's
 * behalf. There is no window here: nothing is imported dynamically, and no
 * message is read, until both syscalls have returned.
 *
 * Nothing below may be moved above the `confine()` call.
 */

import { denyInternetSockets, execSelf, restrictSelf } from '../confinement';
import { ActivationServer } from './activation';
import { BrokerServer, refreshAgentIds } from './brokerServer';
import { send, settleHostAnswer } from './hostChannel';
import { keep, served } from './instances';
import { MemoryServer } from './memoryServer';
import { decodeCrossing, encodeCrossing, flattenFailure } from './protocol';
import { ToolSetServer } from './toolSetServer';

import type { ActivationPlan } from './activation';
import type { BrokerStartPlan } from './brokerServer';
import type { CrossedRequest } from './memoryServer';
import type { ChildPlan, HostMessage } from './protocol';

/** The half of `HostMessage` that asks for something, as opposed to answering. */
type Request = Extract<HostMessage, { kind: 'invoke' | 'load' | 'shutdown' }>;
import type { CrossedContext } from './toolSetServer';
import type {
  Broker,
  ExtensionDefinition,
  MaybePromise,
  Memory,
  OutboundEvent,
  ToolSet,
} from '@nox/extension-api';

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readPlan(): ChildPlan {
  const encoded = process.argv[2];
  if (encoded === undefined) fail('The extension child was started without a plan.');
  return JSON.parse(encoded) as ChildPlan;
}

const plan = readPlan();

/**
 * Set on the second pass, after this process has already confined itself and
 * re-executed. Without it the confinement would loop forever; with it, the
 * process that answers messages is one whose every thread was created after
 * the ruleset existed.
 */
const CONFINED = '--confined';

if (plan.confine && !process.argv.includes(CONFINED)) {
  // Filesystem first, then sockets. Either order confines, but a failure in the
  // second is easier to attribute when the first has already succeeded, and
  // both throw rather than returning a value anyone could ignore.
  restrictSelf({ allowances: plan.allowances, restrictTcp: true });
  denyInternetSockets();
  // And only now become the runtime that will hold the extension. See the note
  // on `execSelf`: the syscalls above bind to this thread, and a pool that
  // already exists is not covered by them.
  execSelf([process.execPath, 'run', process.argv[1] ?? '', process.argv[2] ?? '', CONFINED]);
}

// ---------------------------------------------------------------------------
// Everything below this line runs confined.
// ---------------------------------------------------------------------------

/** The extension's default export, once it has been loaded. */
let loaded: Record<string, unknown> | undefined;

async function load(entryPoint: string): Promise<unknown> {
  const module: unknown = await import(entryPoint);
  const definition =
    typeof module === 'object' && module !== null
      ? (module as { readonly default?: unknown }).default
      : undefined;
  if (typeof definition !== 'object' || definition === null) {
    throw new TypeError('The entry module must default-export an extension definition.');
  }
  loaded = definition as Record<string, unknown>;
  return Object.keys(loaded).sort();
}

/**
 * Builds one of the extension's exports and keeps it under a handle.
 *
 * `bind` is separate from `load` because loading a module and deciding what of
 * it to serve are different questions, and an extension may answer only one of
 * them — a package that contributes a tool set and no memory is ordinary.
 */
async function bound<T>(name: unknown): Promise<T> {
  if (loaded === undefined) throw new Error('The extension has not been loaded.');
  const factory: unknown = loaded[String(name)];
  if (typeof factory !== 'function') {
    throw new TypeError(`The extension exports no factory "${String(name)}".`);
  }
  return await (factory as () => MaybePromise<T>)();
}

/** The extension itself, once the host has asked for it to be activated. */
let activation: ActivationServer | undefined;

async function serveActivation(method: string, params: readonly unknown[]): Promise<unknown> {
  if (method === 'activation.activate') {
    if (loaded === undefined) throw new Error('The extension has not been loaded.');
    activation = new ActivationServer(loaded as unknown as ExtensionDefinition);
    await activation.activate(params[0] as ActivationPlan);
    return null;
  }
  if (activation === undefined) throw new Error('This extension has not been activated.');
  switch (method) {
    case 'activation.contributions':
      return activation.contributions();
    case 'activation.create':
      await activation.create(String(params[0]), String(params[1]), String(params[2]), params[3]);
      return null;
    case 'activation.deactivate':
      await activation.deactivate();
      return null;
    case 'activation.destroy':
      activation.destroy(String(params[0]));
      return null;
    default:
      throw new TypeError(`The transport has no method "${method}".`);
  }
}

async function serveBroker(method: string, params: readonly unknown[]): Promise<unknown> {
  if (method === 'broker.bind') {
    keep(String(params[0]), new BrokerServer(await bound<Broker>(params[1])));
    return null;
  }
  const transport = served(params[0], BrokerServer, 'broker');
  switch (method) {
    case 'broker.canDeliverTo':
      return await transport.canDeliverTo(String(params[1]));
    case 'broker.deliver':
      await transport.deliver(params[1] as OutboundEvent);
      return null;
    case 'broker.openScheduledConversation':
      return await transport.openScheduledConversation();
    case 'broker.principalGroups':
      return await transport.principalGroups(String(params[1]));
    case 'broker.shape':
      return transport.shape();
    case 'broker.start':
      // The agent ids are fetched before the transport is told to start, so the
      // first inbound message cannot arrive before the list it is matched
      // against exists.
      await refreshAgentIds();
      await transport.start(params[1] as BrokerStartPlan);
      return null;
    case 'broker.stop':
      await transport.stop();
      return null;
    default:
      throw new TypeError(`The transport has no method "${method}".`);
  }
}

async function serveMemory(method: string, params: readonly unknown[]): Promise<unknown> {
  if (method === 'memory.bind') {
    keep(String(params[0]), new MemoryServer(await bound<Memory>(params[1])));
    return null;
  }
  const memory = served(params[0], MemoryServer, 'memory');
  if (method === 'memory.capabilities') return memory.capabilities();
  if (method === 'memory.abort') {
    memory.abort(String(params[1]));
    return null;
  }
  return await memory.call(method.slice('memory.'.length), params[1] as CrossedRequest);
}

/**
 * Methods the child answers itself, rather than by calling into the extension.
 *
 * They are named apart from anything an extension exports, so a package cannot
 * shadow the transport by exporting `toolset.run` — which it cannot do with a
 * dot in the name, and that is the reason for the dot.
 */
async function serveToolSet(method: string, params: readonly unknown[]): Promise<unknown> {
  if (method === 'toolset.bind') {
    keep(String(params[0]), new ToolSetServer(await bound<ToolSet>(params[1])));
    return null;
  }
  const toolSet = served(params[0], ToolSetServer, 'tool set');
  switch (method) {
    case 'toolset.abort':
      toolSet.abort(String(params[1]));
      return null;
    case 'toolset.acknowledge':
      return await toolSet.acknowledge(String(params[1]), params[2] as CrossedContext);
    case 'toolset.declarations':
      return toolSet.declarations();
    case 'toolset.describe':
      return toolSet.describe();
    case 'toolset.prepare':
      return await toolSet.prepare(String(params[1]), params[2]);
    case 'toolset.result':
      return await toolSet.result(String(params[1]));
    case 'toolset.run':
      return await toolSet.run(String(params[1]), params[2] as CrossedContext);
    default:
      throw new TypeError(`The transport has no method "${method}".`);
  }
}

async function invoke(method: string, params: readonly unknown[]): Promise<unknown> {
  if (method.startsWith('activation.')) return await serveActivation(method, params);
  if (method.startsWith('toolset.')) return await serveToolSet(method, params);
  if (method.startsWith('memory.')) return await serveMemory(method, params);
  if (method.startsWith('broker.')) return await serveBroker(method, params);
  if (loaded === undefined) throw new Error('The extension has not been loaded.');
  const target: unknown = loaded[method];
  if (typeof target !== 'function') {
    throw new TypeError(`The extension exports no callable "${method}".`);
  }
  return await (target as (...args: readonly unknown[]) => unknown)(...params);
}

async function handle(message: Request): Promise<void> {
  if (message.kind === 'shutdown') {
    process.exit(0);
  }
  try {
    const value =
      message.kind === 'load'
        ? await load(message.entryPoint)
        : await invoke(message.method, decodeCrossing(message.params) as readonly unknown[]);
    send({ id: message.id, kind: 'settled', value: encodeCrossing(value) });
  } catch (cause) {
    send({ error: flattenFailure(cause), id: message.id, kind: 'failed' });
  }
}

process.on('message', (message: HostMessage) => {
  if (settleHostAnswer(message)) return;
  void handle(message);
});

// A child whose host has gone is answering nobody. Left running it would hold a
// confined process, its memory, and whatever it had open, for as long as Nox
// lives — which is the shape of every leak that only shows up after a week.
process.on('disconnect', () => {
  process.exit(0);
});
