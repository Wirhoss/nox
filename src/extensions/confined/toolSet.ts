import { ToolSet } from '@nox/extension-api';

import type { CrossedContext, CrossedPreparation } from './toolSetServer';
import type {
  MessageContent,
  PreparedToolCall,
  ToolContext,
  ToolDeclaration,
} from '@nox/extension-api';

/** The one thing this needs from a channel, so it is not tied to a process. */
interface ToolSetChannel {
  invoke(method: string, ...params: readonly unknown[]): Promise<unknown>;
}

interface RemoteToolSetOptions {
  readonly channel: ToolSetChannel;
  readonly declarations: Readonly<Record<string, ToolDeclaration>>;
  readonly description: string;
  readonly enabledTools?: readonly string[];
  readonly name: string;
}

/**
 * A tool set whose tools are in another process.
 *
 * It is a `ToolSet`, not something that resembles one, because every consumer
 * in the kernel — the table, the renderer, the token estimator, the gate —
 * reads `declarations` and calls `prepare`, and none of them should learn that
 * a set can be somewhere else. The two members they use are the two the
 * contract was reshaped to make answerable from a message.
 *
 * The declarations are fetched once, when the set is built, rather than on
 * every read. A set that changed its tools between two renders would already
 * be a bug in process; across a boundary it would also be a round trip on the
 * path that runs most.
 */
class RemoteToolSet extends ToolSet {
  readonly #channel: ToolSetChannel;
  readonly #remoteDeclarations: Readonly<Record<string, ToolDeclaration>>;

  constructor(options: RemoteToolSetOptions) {
    super(options.name, options.description, options.enabledTools);
    this.#channel = options.channel;
    this.#remoteDeclarations = Object.freeze({ ...options.declarations });
  }

  /**
   * Builds one from whatever is on the other end, by asking it.
   *
   * The host never constructs the extension's set, which is the whole point:
   * the code that decides what tools exist runs confined, and what comes back
   * is a document.
   */
  public static async connect(
    channel: ToolSetChannel,
    enabledTools?: readonly string[],
  ): Promise<RemoteToolSet> {
    const described = (await channel.invoke('toolset.describe')) as {
      readonly description: string;
      readonly name: string;
    };
    const declarations = (await channel.invoke('toolset.declarations')) as Readonly<
      Record<string, ToolDeclaration>
    >;
    return new RemoteToolSet({
      channel,
      declarations,
      description: described.description,
      ...(enabledTools === undefined ? {} : { enabledTools }),
      name: described.name,
    });
  }

  public override get declarations(): Readonly<Record<string, ToolDeclaration>> {
    return this.#remoteDeclarations;
  }

  public override async prepare(name: string, rawParams: unknown): Promise<PreparedToolCall> {
    const crossed = (await this.#channel.invoke(
      'toolset.prepare',
      name,
      rawParams,
    )) as CrossedPreparation;
    return this.#rebuild(crossed);
  }

  /** Nothing to register: the tools are not here. */
  protected override addTools(): void {
    // Intentionally empty.
  }

  /**
   * Puts the closure back on the descriptive half.
   *
   * The record that comes back is data; `run` is added here and calls over the
   * channel, so what the runner receives is indistinguishable from a call
   * prepared in process — including that its abort signal works, which it does
   * by sending a message rather than by crossing.
   */
  #rebuild(crossed: CrossedPreparation): PreparedToolCall {
    const descriptive = {
      ...(crossed.gateSubject === undefined ? {} : { gateSubject: crossed.gateSubject }),
      params: crossed.params,
      ...(crossed.preview === undefined ? {} : { preview: crossed.preview }),
      ...(crossed.risk === undefined ? {} : { risk: crossed.risk }),
      title: crossed.title,
    };

    if (crossed.type === 'immediate') {
      return Object.freeze({
        ...descriptive,
        run: async (ctx: ToolContext): Promise<MessageContent[]> =>
          await this.#withAbort(
            crossed.callId,
            ctx,
            async () =>
              (await this.#channel.invoke(
                'toolset.run',
                crossed.callId,
                crossedContext(ctx),
              )) as MessageContent[],
          ),
        type: 'immediate' as const,
      });
    }

    return Object.freeze({
      ...descriptive,
      run: async (
        ctx: ToolContext,
      ): Promise<{ ack: MessageContent[]; result: Promise<MessageContent[]> }> => {
        const ack = (await this.#channel.invoke(
          'toolset.acknowledge',
          crossed.callId,
          crossedContext(ctx),
        )) as MessageContent[];
        // The second half is asked for now and awaited by the caller later,
        // which is what keeps the abort wiring alive for the whole call rather
        // than only for the acknowledgement.
        const result = this.#withAbort(
          crossed.callId,
          ctx,
          async () =>
            (await this.#channel.invoke('toolset.result', crossed.callId)) as MessageContent[],
        );
        return { ack, result };
      },
      type: 'deferred' as const,
    });
  }

  async #withAbort<T>(callId: string, ctx: ToolContext, body: () => Promise<T>): Promise<T> {
    const onAbort = (): void => {
      // Told, not just forgotten: a child that is not informed keeps working on
      // a result nobody will read, in a process nobody is watching.
      void this.#channel.invoke('toolset.abort', callId).catch(() => undefined);
    };
    ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
    try {
      return await body();
    } finally {
      ctx.abortSignal.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * The part of a context a JSON document can carry.
 *
 * Everything omitted here is a live host object. See the note in
 * `toolSetServer.ts`: they are absent on the far side rather than faked.
 */
function crossedContext(ctx: ToolContext): CrossedContext {
  return {
    ...(ctx.session === undefined ? {} : { session: ctx.session }),
    ...(ctx.toolSetId === undefined ? {} : { toolSetId: ctx.toolSetId }),
  };
}

export { RemoteToolSet };
export type { RemoteToolSetOptions, ToolSetChannel };
