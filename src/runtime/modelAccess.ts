import { isChatCapable, isEmbeddingCapable } from '@nox/extension-api';

import type {
  BaseProvider,
  ChatModel,
  ChatModelConfig,
  ChatProvider,
  EmbeddingCapable,
  EmbeddingModel,
  EmbeddingModelConfig,
  EmbedResult,
  Message,
  ModelAccess,
  ModelReference,
  ProviderStream,
  TextGenerateOptions,
  Tool,
} from '@nox/extension-api';

/**
 * The live configured provider instances, looked up by the name an operator
 * gave them.
 *
 * Narrower than the runtime that owns them on purpose: reaching a model is the
 * only thing being handed out here, and a wider handle would let an extension
 * reconcile the installation it is running inside.
 */
interface ProviderRegistry {
  /** Throws unless the named instance is configured and activated. */
  provider(providerId: string): BaseProvider;
}

interface ResolvedChat {
  readonly model: ChatModelConfig;
  readonly provider: ChatProvider;
}

interface ResolvedEmbedding {
  readonly model: EmbeddingModelConfig;
  readonly provider: BaseProvider & EmbeddingCapable;
}

/**
 * Nox's answer to `modelAccessService`.
 *
 * Connected after composition, like the configuration runtime itself: no
 * provider exists while extensions are activating, and the service has to be on
 * the container before the first of them asks for it. Contributions are created
 * during reconciliation, which is after both, so nothing that legitimately
 * needs a model ever meets the unconnected relay.
 */
class ModelAccessRelay implements ModelAccess {
  #registry?: ProviderRegistry;

  public connect(registry: ProviderRegistry): void {
    this.#registry = registry;
  }

  public chat(target: ModelReference): ChatModel {
    const reference = Object.freeze({ model: target.model, provider: target.provider });
    // Resolved once here so a mistyped provider or model is reported while the
    // component that named it is being built, and again on every call so the
    // handle never speaks to a provider the configuration has since replaced.
    this.#chat(reference);
    return Object.freeze({
      config: (): ChatModelConfig => this.#chat(reference).model,
      reference,
      stream: (
        systemPrompt: string,
        history: readonly Message[],
        tools: readonly Tool[],
        options?: Omit<TextGenerateOptions, 'model'>,
      ): ProviderStream => {
        const resolved = this.#chat(reference);
        return resolved.provider.getMessageStream(systemPrompt, [...history], [...tools], {
          ...options,
          model: resolved.model,
        });
      },
    });
  }

  public embedding(target: ModelReference): EmbeddingModel {
    const reference = Object.freeze({ model: target.model, provider: target.provider });
    this.#embedding(reference);
    return Object.freeze({
      config: (): EmbeddingModelConfig => this.#embedding(reference).model,
      embed: (texts: readonly string[], signal?: AbortSignal): Promise<EmbedResult> =>
        this.#embedding(reference).provider.embed({
          modelId: reference.model,
          ...(signal === undefined ? {} : { signal }),
          texts,
        }),
      reference,
    });
  }

  #chat(reference: ModelReference): ResolvedChat {
    const provider = this.#provider(reference);
    if (!isChatCapable(provider)) {
      throw new Error(
        `Provider "${reference.provider}" serves no chat model, so nothing can be streamed ` +
          'through it. Name a provider that does.',
      );
    }
    // The same rule the kernel applies when an agent names a model: a chat model
    // need not be declared, because everything about it can be defaulted. Only a
    // model declared as an embedding one is refused, and it is refused in the
    // words an operator has already seen elsewhere. Anything stricter here would
    // make a provider that works for an agent fail for a memory.
    const declared = provider.getModelConfig(reference.model);
    if (declared?.kind === 'embedding') {
      throw new Error(`Model "${reference.model}" is configured for embeddings, not conversation.`);
    }
    return {
      model: declared ?? {
        inputModalities: ['text'],
        kind: 'chat',
        modelId: reference.model,
        outputModalities: ['text'],
      },
      provider,
    };
  }

  #embedding(reference: ModelReference): ResolvedEmbedding {
    const provider = this.#provider(reference);
    if (!isEmbeddingCapable(provider)) {
      throw new Error(
        `Provider "${reference.provider}" serves no embedding model, so nothing can be ` +
          'turned into vectors through it. Name a provider that does.',
      );
    }
    const model = provider.embeddingModelConfig(reference.model);
    if (model === undefined) {
      throw new Error(
        `Provider "${reference.provider}" serves no embedding model "${reference.model}". ` +
          'Add it to that provider modelConfigs, or name a model it already serves.',
      );
    }
    return { model, provider };
  }

  #provider(reference: ModelReference): BaseProvider {
    const registry = this.#registry;
    if (registry === undefined) {
      throw new Error(
        `Model "${reference.provider}/${reference.model}" was asked for before Nox had ` +
          'configured any provider. Take a model when a contribution is created, not while ' +
          'an extension is activating.',
      );
    }
    return registry.provider(reference.provider);
  }
}

export { ModelAccessRelay };

export type { ProviderRegistry };
