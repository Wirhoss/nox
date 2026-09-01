import type { Memory } from '@nox/extension-api';

/**
 * The child's half of a memory.
 *
 * Simpler than a tool set, because the contract already is: every method takes
 * a request and answers with data. The only thing in a request that cannot
 * cross is its `AbortSignal`, so the host sends a call id in its place, the
 * signal is created here, and cancellation is a message that names the id.
 *
 * The three optional members are reported rather than assumed. `blocks`,
 * `editor` and `inspector` each mean something by their *absence* — a memory
 * with no editor cannot be granted Nox's editing tools at all — so a proxy that
 * offered all three would quietly grant an extension surfaces it never claimed.
 */

/** Which optional surfaces the far side actually has. */
interface MemoryCapabilities {
  readonly blocks: boolean;
  readonly editor: boolean;
  readonly inspector: boolean;
}

/** A request as it arrives: its signal replaced by the id that can abort it. */
type CrossedRequest = Readonly<Record<string, unknown>> & { readonly callId: string };

class MemoryServer {
  readonly #calls = new Map<string, AbortController>();
  readonly #memory: Memory;

  constructor(memory: Memory) {
    this.#memory = memory;
  }

  public capabilities(): MemoryCapabilities {
    return {
      blocks: this.#memory.blocks !== undefined,
      editor: this.#memory.editor !== undefined,
      inspector: this.#memory.inspector !== undefined,
    };
  }

  public abort(callId: string): void {
    this.#calls.get(callId)?.abort();
  }

  /**
   * Routes one call to the memory, with a signal that this side owns.
   *
   * Written as one dispatch rather than a method each, because every one of
   * these has exactly the same shape and a dozen near-identical wrappers is a
   * dozen places for the request to be rebuilt slightly differently.
   */
  public async call(method: string, request: CrossedRequest): Promise<unknown> {
    const controller = new AbortController();
    this.#calls.set(request.callId, controller);
    try {
      return await this.#dispatch(method, { ...request, signal: controller.signal });
    } finally {
      this.#calls.delete(request.callId);
    }
  }

  async #dispatch(method: string, request: Record<string, unknown>): Promise<unknown> {
    const memory = this.#memory;
    switch (method) {
      case 'blocks.read':
        return await this.#surface(memory.blocks, 'blocks').read(request as never);
      case 'blocks.write':
        return await this.#surface(memory.blocks, 'blocks').write(request as never);
      case 'editor.forget':
        return await this.#surface(memory.editor, 'editor').forget(request as never);
      case 'editor.search':
        return await this.#surface(memory.editor, 'editor').search(request as never);
      case 'editor.update':
        return await this.#surface(memory.editor, 'editor').update(request as never);
      case 'editor.write':
        return await this.#surface(memory.editor, 'editor').write(request as never);
      case 'inspector.episodes':
        return await this.#surface(memory.inspector, 'inspector').episodes(request as never);
      case 'inspector.facts':
        return await this.#surface(memory.inspector, 'inspector').facts(request as never);
      case 'inspector.scopes':
        // The one method that takes a bare signal rather than a request.
        return await this.#surface(memory.inspector, 'inspector').scopes(
          request.signal as AbortSignal,
        );
      case 'recall':
        return await memory.recall(request as never);
      case 'retain': {
        await memory.retain(request as never);
        return;
      }
      default:
        throw new TypeError(`A memory has no method "${method}".`);
    }
  }

  #surface<T>(surface: T | undefined, name: string): T {
    if (surface === undefined) throw new TypeError(`This memory has no ${name}.`);
    return surface;
  }
}

export { MemoryServer };
export type { CrossedRequest, MemoryCapabilities };
