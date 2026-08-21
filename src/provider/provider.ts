import { parseOrThrow } from '../utils/validate';
import {
  type ModelConfig,
  providerBaseConfigSchema,
  type ProviderRuntimeConfigInput,
  providerRuntimeConfigSchema,
  type TextGenerateOptions,
} from './config';
import { toProviderError } from './error';
import { type ProviderSourceEvent, ProviderStream } from './stream';

import type { Message } from '../agent/context/message';
import type { SecretHandle } from '../config/secrets';
import type { Tool } from '../tool/tool';

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  if (delayMs === 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined = undefined;
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(abortReason(signal));
    };
    timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

abstract class BaseProvider {
  static readonly configSchema = providerBaseConfigSchema;

  protected apiKey?: SecretHandle;
  protected baseUrl: string;
  protected timeoutMs?: number;

  protected modelConfigs: Record<string, ModelConfig> = {};

  protected readonly maxRetries: number;
  protected readonly maxRetryDelayMs: number;
  protected readonly retryDelayMs: number;

  constructor(input: ProviderRuntimeConfigInput) {
    const config = parseOrThrow(providerRuntimeConfigSchema, input);
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.maxRetries = config.maxRetries;
    this.maxRetryDelayMs = config.maxRetryDelayMs;
    this.retryDelayMs = config.retryDelayMs;
    this.timeoutMs = config.timeoutMs;

    for (const modelConfig of config.modelConfigs ?? []) {
      this.addModelConfig(modelConfig);
    }
  }

  public get modelCount(): number {
    return Object.keys(this.modelConfigs).length;
  }

  public abstract fetchModelIds(): Promise<string[]>;

  public addModelConfig(modelConfig: ModelConfig): void {
    if (this.modelConfigs[modelConfig.modelId] !== undefined) {
      throw new Error(`Model config for modelId ${modelConfig.modelId} already exists.`);
    }
    this.modelConfigs[modelConfig.modelId] = modelConfig;
  }

  public getModelConfig(modelId: string): ModelConfig | undefined {
    return this.modelConfigs[modelId];
  }

  public listModelConfigs(): ModelConfig[] {
    return Object.values(this.modelConfigs);
  }
}

abstract class ChatProvider extends BaseProvider {
  public getMessageStream(
    systemPrompt: string,
    messageHistory: Message[],
    tools: Tool[],
    opts?: TextGenerateOptions,
  ): ProviderStream {
    const signal = opts?.signal ?? new AbortController().signal;
    const source = this.streamWithRetries(systemPrompt, messageHistory, tools, opts, signal);
    return new ProviderStream(source, signal);
  }

  /** Creates the raw event source for one provider request. */
  protected abstract attempt(
    systemPrompt: string,
    messageHistory: Message[],
    tools: Tool[],
    opts: TextGenerateOptions | undefined,
    signal: AbortSignal,
  ): AsyncIterable<ProviderSourceEvent>;

  private async *streamWithRetries(
    systemPrompt: string,
    messageHistory: Message[],
    tools: Tool[],
    opts: TextGenerateOptions | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderSourceEvent> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        for await (const event of this.attempt(systemPrompt, messageHistory, tools, opts, signal)) {
          if (event.type === 'error') throw event.error;
          yield event;
        }
        return;
      } catch (error) {
        if (signal.aborted) throw error;

        const providerError = toProviderError(error);
        if (providerError.code !== 'connection' || attempt > this.maxRetries) {
          throw providerError;
        }

        const delayMs = Math.min(this.retryDelayMs * 2 ** (attempt - 1), this.maxRetryDelayMs);
        yield {
          attempt,
          delayMs,
          error: providerError,
          resetOutput: true,
          type: 'retry',
        };
        await waitForRetry(delayMs, signal);
      }
    }
  }
}

type Provider = ChatProvider;

export { BaseProvider, ChatProvider };

export type { Provider };
