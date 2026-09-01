import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { unconfinableReason } from '../confinement';
import { decodeCrossing, encodeCrossing, flattenFailure } from './protocol';

import type { Logger } from '../../logger/logger';
import type { Allowance } from '../confinement';
import type { BrokerChannel } from './broker';
import type { ChildMessage, ChildPlan, HostMessage } from './protocol';

/** The part of a child this host uses, so a test can supply one that is not a process. */
interface ChildLike {
  /** Resolves with the exit code once the child is gone. */
  readonly exited: Promise<number>;
  kill(): void;
  send(message: HostMessage): void;
}

interface Spawned {
  readonly child: ChildLike;
  /**
   * Whatever the child writes to stderr. A confined process that dies before
   * it can send a message — because it failed to confine itself, or because
   * its entry module threw on import — has nowhere else to say why, and a
   * boundary that swallowed that would be a boundary nobody could debug.
   */
  readonly stderr?: ReadableStream<Uint8Array>;
  /** Registers the only two things the host learns from a child on its own. */
  onMessage(listener: (message: ChildMessage) => void): void;
}

interface ExtensionProcessOptions {
  readonly allowances: readonly { readonly path: string; readonly write: boolean }[];
  readonly extensionId: string;
  readonly logger: Logger;
  /**
   * Run without confinement on a kernel that has none. Never a fallback: the
   * host refuses by default and this is the operator saying otherwise, which is
   * why it is a required decision rather than an optional flag.
   */
  readonly runUnconfined?: boolean;
  /** How long the child gets to leave on its own before it is killed. */
  readonly shutdownGraceMs?: number;
  /** Supplied by tests. Production spawns the child beside this file. */
  readonly spawn?: (plan: ChildPlan) => Spawned;
}

interface Pending {
  readonly reject: (error: Error) => void;
  readonly resolve: (value: unknown) => void;
}

/** Thrown when the child cannot answer, whatever the reason it cannot. */
class ExtensionProcessError extends Error {
  public readonly extensionId: string;

  constructor(extensionId: string, reason: string) {
    super(`The process for extension "${extensionId}" ${reason}.`);
    this.extensionId = extensionId;
    this.name = 'ExtensionProcessError';
  }
}

/** Thrown by the extension itself, carried across with its name intact. */
class ExtensionCallError extends Error {
  constructor(name: string, message: string, stack: string | undefined) {
    super(message);
    this.name = name;
    if (stack !== undefined) this.stack = stack;
  }
}

/** Long enough for an in-flight call to finish, short enough to not hang a shutdown. */
const SHUTDOWN_GRACE_MS = 5_000;

function childFile(): string {
  return import.meta.url.endsWith('.ts') ? './child.ts' : './child.js';
}

function childPath(): string {
  return fileURLToPath(new URL(childFile(), import.meta.url));
}

/**
 * Read access to Nox's own modules, which the child needs and the caller should
 * not have to know about.
 *
 * The child re-executes itself after applying the ruleset — that is what makes
 * the confinement cover every thread — so it has to be able to read its own
 * program *after* it is confined, along with everything that program imports.
 * Without this the child dies at `execve` with `EACCES` on its own file, which
 * is a confusing way to learn it.
 *
 * Two directories up from the child module covers the imports it has in the
 * source layout and stops well short of the filesystem root; if it ever would
 * not, the child's own directory is used instead. `DATA_DIR` is nowhere near
 * either, which is the property that matters.
 */
function runtimeAllowance(): Allowance {
  const own = dirname(childPath());
  const above = resolvePath(own, '..', '..');
  return { path: above === '/' || above.length < own.length - 40 ? own : above, write: false };
}

let nextCallId = 0;

/**
 * One confined process, holding one installed extension.
 *
 * A process rather than a worker thread, and the difference was measured: a
 * `Worker` running an extension body imported `node:fs`, spawned a child, read
 * `process.env` and opened a socket. It isolates a module graph and a crash,
 * which is not what this is for. A process can be handed a kernel ruleset it
 * cannot take off, and so can everything it spawns.
 *
 * The child is started eagerly rather than on the first call, because the point
 * at which it fails to confine itself is a fact about the installation that an
 * operator should learn at startup — not the first time somebody asks the
 * extension to do something.
 */
class ExtensionProcess {
  readonly #extensionId: string;
  readonly #logger: Logger;
  readonly #pending = new Map<string, Pending>();
  readonly #shutdownGraceMs: number;
  readonly #answers = new Map<
    string,
    (method: string, params: readonly unknown[]) => Promise<unknown>
  >();

  #child?: ChildLike;
  #disposed = false;

  constructor(options: ExtensionProcessOptions) {
    this.#extensionId = options.extensionId;
    this.#logger = options.logger;
    this.#shutdownGraceMs = options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;

    const unconfinable = unconfinableReason();
    const confine = unconfinable === undefined;
    if (!confine) {
      if (options.runUnconfined !== true) {
        throw new ExtensionProcessError(
          options.extensionId,
          `cannot be confined and was not permitted to run without it — ${unconfinable}`,
        );
      }
      // Every start, not once: an installation running extensions unconfined
      // should never be able to forget that it is.
      this.#logger.warn(
        { extensionId: options.extensionId, reason: unconfinable },
        'Running an installed extension without confinement, because this installation was configured to.',
      );
    }

    const plan: ChildPlan = {
      allowances: [runtimeAllowance(), ...options.allowances],
      confine,
      extensionId: options.extensionId,
    };
    const spawned = (options.spawn ?? spawnChild)(plan);
    this.#child = spawned.child;
    spawned.onMessage((message) => {
      this.#receive(message);
    });
    if (spawned.stderr !== undefined) void this.#forwardStderr(spawned.stderr);
    // A child that dies takes every in-flight call with it. Rejecting here is
    // what keeps a crash from presenting as a call that never returns.
    void spawned.child.exited.then((code) => {
      this.#drop(spawned.child, `exited with code ${String(code)}`);
    });
  }

  /**
   * Registers what the child is allowed to call back into, under one prefix.
   *
   * A registry rather than a single handler, because more than one thing on
   * this side answers: a broker's `BrokerHost` today, and whatever needs the
   * same direction next. Registering a prefix twice is refused rather than
   * merged — two owners of one namespace is a routing bug that would otherwise
   * present as calls silently reaching the wrong one.
   */
  public answer(
    prefix: string,
    handler: (method: string, params: readonly unknown[]) => Promise<unknown>,
  ): void {
    if (this.#answers.has(prefix)) {
      throw new ExtensionProcessError(this.#extensionId, `already answers "${prefix}"`);
    }
    this.#answers.set(prefix, handler);
  }

  /**
   * A view of this process addressed to one instance inside it.
   *
   * The handle goes in ahead of every call, so the proxies on this side —
   * `RemoteToolSet`, `connectMemory`, `connectBroker` — need to know nothing
   * about which of the extension's several contributions they are talking to.
   * One extension holding two transports and a memory is ordinary, and none of
   * them should have learned to carry an address for that.
   */
  public scoped(handle: string): BrokerChannel {
    return {
      answer: (prefix, handler) => {
        this.answer(prefix, handler);
      },
      invoke: async (method, ...params) => await this.invoke(method, handle, ...params),
    };
  }

  /** Loads the extension's entry module inside the child, and lists what it exports. */
  public async load(entryPoint: string): Promise<readonly string[]> {
    return (await this.#request((id) => ({ entryPoint, id, kind: 'load' }))) as readonly string[];
  }

  public async invoke(method: string, ...params: readonly unknown[]): Promise<unknown> {
    return await this.#request((id) => ({
      id,
      kind: 'invoke',
      method,
      params: params.map((param) => encodeCrossing(param)),
    }));
  }

  /**
   * Asks the child to stop, and only kills it if it will not.
   *
   * The same lesson the model worker learned: tearing a runtime down wherever
   * it happens to be is how a shutdown turns into a crash. A package mid-write
   * to its own database is worth a bounded moment.
   */
  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const child = this.#child;
    this.#child = undefined;
    this.#rejectAll('has been released');
    if (child === undefined) return;

    const left = await Promise.race([
      child.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => {
          resolve(false);
        }, this.#shutdownGraceMs);
      }),
      (async (): Promise<boolean> => {
        try {
          child.send({ kind: 'shutdown' });
        } catch {
          return true; // Already gone; nothing left to ask.
        }
        return await child.exited.then(() => true);
      })(),
    ]);
    if (left) return;

    this.#logger.warn(
      { extensionId: this.#extensionId, graceMs: this.#shutdownGraceMs },
      'An extension process did not stop when asked; killing it.',
    );
    child.kill();
  }

  async #forwardStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let carry = '';
    for await (const chunk of stream) {
      carry += decoder.decode(chunk, { stream: true });
      const lines = carry.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim().length > 0) {
          this.#logger.error({ extensionId: this.#extensionId }, line);
        }
      }
    }
    if (carry.trim().length > 0) this.#logger.error({ extensionId: this.#extensionId }, carry);
  }

  async #request(build: (id: string) => HostMessage): Promise<unknown> {
    if (this.#disposed) throw new ExtensionProcessError(this.#extensionId, 'has been released');
    const child = this.#child;
    if (child === undefined) throw new ExtensionProcessError(this.#extensionId, 'is not running');

    const id = `call-${String(++nextCallId)}`;
    const settled = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
    });
    try {
      child.send(build(id));
      return await settled;
    } finally {
      this.#pending.delete(id);
    }
  }

  #receive(message: ChildMessage): void {
    if (message.kind === 'call') {
      void this.#answerCall(message.id, message.method, message.params);
      return;
    }
    if (message.kind === 'log') {
      // Stamped by the host, so a package cannot claim a line it did not write.
      this.#logger[message.level](
        { ...message.fields, extensionId: this.#extensionId },
        message.message,
      );
      return;
    }
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    if (message.kind === 'settled') pending.resolve(decodeCrossing(message.value));
    else
      pending.reject(
        new ExtensionCallError(message.error.name, message.error.message, message.error.stack),
      );
  }

  /**
   * Answers one call from the child.
   *
   * A method nobody registered is refused by name rather than ignored: a
   * transport waiting forever on a callback the host never wired is the exact
   * failure this whole direction exists to make visible.
   */
  async #answerCall(id: string, method: string, params: readonly unknown[]): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;
    try {
      const prefix = [...this.#answers.keys()].find((candidate) => method.startsWith(candidate));
      const handler = prefix === undefined ? undefined : this.#answers.get(prefix);
      if (handler === undefined) {
        throw new TypeError(`Nothing on the host answers "${method}".`);
      }
      const value = await handler(method, decodeCrossing(params) as readonly unknown[]);
      child.send({ id, kind: 'answered', value: encodeCrossing(value) });
    } catch (cause) {
      try {
        child.send({ error: flattenFailure(cause), id, kind: 'refused' });
      } catch {
        // The child is gone; there is nobody left to refuse.
      }
    }
  }

  #drop(child: ChildLike, reason: string): void {
    if (this.#child === child) this.#child = undefined;
    if (this.#disposed) return;
    this.#rejectAll(reason);
  }

  #rejectAll(reason: string): void {
    for (const [id, pending] of [...this.#pending]) {
      this.#pending.delete(id);
      pending.reject(new ExtensionProcessError(this.#extensionId, reason));
    }
  }
}

function spawnChild(plan: ChildPlan): Spawned {
  let listener: ((message: ChildMessage) => void) | undefined;
  const child = Bun.spawn({
    cmd: [process.execPath, 'run', childPath(), JSON.stringify(plan)],
    ipc(message: ChildMessage) {
      listener?.(message);
    },
    // JSON rather than a structured clone, so the boundary cannot carry a live
    // object even by accident. See the note in `protocol.ts`.
    serialization: 'json',
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });

  return {
    child: {
      exited: child.exited,
      kill: () => {
        child.kill();
      },
      send: (message) => {
        child.send(message);
      },
    },
    onMessage: (next) => {
      listener = next;
    },
    stderr: child.stderr,
  };
}

export { ExtensionCallError, ExtensionProcess, ExtensionProcessError };
export type { ChildLike, ExtensionProcessOptions, Spawned };
