import { z } from 'zod';

import { type Logger, silentLogger } from '../../../logger/logger';
import {
  type ModelConfig,
  providerBaseConfigSchema,
  type TextGenerateOptions,
} from '../../../provider/config';
import { ProviderError, type ProviderErrorCode } from '../../../provider/error';
import { ChatProvider } from '../../../provider/provider';

import type { Message, MessageContent, ToolCallMessage } from '../../../agent/context/message';
import type { ProviderSourceEvent, ToolCallDraft } from '../../../provider/stream';
import type { Tool } from '../../../tool/tool';

const openAICompletionsConfigSchema = providerBaseConfigSchema.extend({
  defaultModel: z.string().min(1).optional(),
  type: z.literal('openai_completions'),
});

type OpenAICompletionsConfig = z.infer<typeof openAICompletionsConfigSchema>;
type OpenAICompletionsConfigInput = z.input<typeof openAICompletionsConfigSchema>;

interface OpenAICompletionsOptions {
  logger?: Logger;
}

type OpenAIContentPart =
  { type: 'image_url'; image_url: { url: string } } | { type: 'text'; text: string };

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    arguments: string;
    name: string;
  };
}

type OpenAIMessage =
  | { role: 'assistant'; content: null | string; tool_calls?: OpenAIToolCall[] }
  | { role: 'system'; content: string }
  | { role: 'tool'; content: string; tool_call_id: string }
  | { role: 'user'; content: OpenAIContentPart[] | string };

interface OpenAIUsage {
  completion_tokens: number;
  prompt_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

interface OpenAIStreamDelta {
  content?: null | string;
  reasoning?: null | string;
  reasoning_content?: null | string;
  tool_calls?: {
    index: number;
    id?: string;
    function?: {
      arguments?: string;
      name?: string;
    };
  }[];
}

interface OpenAIStreamChunk {
  choices?: {
    delta?: OpenAIStreamDelta;
  }[];
  error?: {
    code?: string;
    message?: string;
    type?: string;
  };
  usage?: null | OpenAIUsage;
}

interface PendingToolCall {
  arguments: string;
  id: string;
  name: string;
}

interface OpenAIErrorDetails {
  code?: string;
  message?: string;
  type?: string;
}

const OPENAI_PROVIDER = 'openai_completions';

const MAX_ERROR_DETAIL_LENGTH = 500;

const DATA_PREFIX = 'data:';

// Completions has no role for "this is a summary of what we dropped", and a
// mid-conversation `system` message reads as an instruction rather than as
// reference material. A marked user turn keeps it inert and keeps image parts.
const COMPACTION_HEADER = '[conversation summary]\n';

function classifyOpenAIError(
  status: number | undefined,
  details: OpenAIErrorDetails,
): ProviderErrorCode {
  const signature = [details.code, details.type, details.message]
    .filter((value): value is string => value !== undefined)
    .join(' ')
    .toLowerCase();

  if (
    status === 401 ||
    status === 403 ||
    signature.includes('invalid_api_key') ||
    signature.includes('authentication')
  ) {
    return 'authentication';
  }

  if (
    signature.includes('context_length') ||
    signature.includes('context limit') ||
    signature.includes('context window') ||
    signature.includes('maximum context') ||
    signature.includes('prompt is too long') ||
    signature.includes('too many tokens')
  ) {
    return 'context_limit';
  }

  if (
    signature.includes('insufficient_quota') ||
    signature.includes('quota_exceeded') ||
    signature.includes('billing_hard_limit') ||
    signature.includes('credit balance') ||
    signature.includes('usage limit')
  ) {
    return 'usage_limit';
  }

  if (status === 429 || signature.includes('rate_limit')) return 'rate_limit';
  if (status !== undefined && [400, 404, 409, 422].includes(status)) return 'invalid_request';

  return 'provider_error';
}

function createOpenAIConnectionError(
  error: unknown,
  message = 'OpenAI connection failed',
): ProviderError {
  const detail = error instanceof Error && error.message.length > 0 ? `: ${error.message}` : '';
  return new ProviderError('connection', `${message}${detail}`, {
    cause: error,
    provider: OPENAI_PROVIDER,
  });
}

function createOpenAIError(
  operation: string,
  details: OpenAIErrorDetails,
  status?: number,
  cause?: unknown,
): ProviderError {
  const statusSuffix = status === undefined ? '' : ` (${String(status)})`;
  const detailSuffix = details.message === undefined ? '' : `: ${details.message}`;

  return new ProviderError(
    classifyOpenAIError(status, details),
    `OpenAI ${operation} failed${statusSuffix}${detailSuffix}`,
    {
      cause,
      provider: OPENAI_PROVIDER,
      providerCode: details.code ?? details.type,
      status,
    },
  );
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function parseOpenAIErrorDetails(detail: string): OpenAIErrorDetails {
  try {
    const body = JSON.parse(detail) as unknown;
    if (body !== null && typeof body === 'object') {
      const record = body as Record<string, unknown>;
      const nested = record.error;
      const error =
        nested !== null && typeof nested === 'object'
          ? (nested as Record<string, unknown>)
          : record;

      return {
        code: readString(error, 'code'),
        message: readString(error, 'message') ?? readString(record, 'message'),
        type: readString(error, 'type'),
      };
    }
  } catch {
    // Non-JSON responses are still useful as a bounded diagnostic message.
  }

  return detail.length > 0 ? { message: detail.slice(0, MAX_ERROR_DETAIL_LENGTH) } : {};
}

interface StreamFragments {
  content?: string;
  done?: boolean;
  reasoning?: string;
}

/** Reasoning before text: one delta produced them in that order. */
function* emitFragments(fragments: StreamFragments): Generator<ProviderSourceEvent> {
  if (fragments.reasoning !== undefined && fragments.reasoning.length > 0) {
    yield { text: fragments.reasoning, type: 'reasoningFragment' };
  }
  if (fragments.content !== undefined && fragments.content.length > 0) {
    yield { text: fragments.content, type: 'textFragment' };
  }
}

/**
 * The OpenAI Chat Completions API, and anything that speaks it. Streaming only:
 * the runner needs fragments as they arrive, and `stream_options.include_usage`
 * is the one place this API reports what the request actually cost.
 */
class OpenAICompletions extends ChatProvider {
  static override readonly configSchema = openAICompletionsConfigSchema;

  private readonly defaultModel?: string;
  private readonly logger: Logger;

  constructor(config: OpenAICompletionsConfigInput, options: OpenAICompletionsOptions = {}) {
    super(config);
    this.defaultModel = config.defaultModel;
    this.logger = options.logger ?? silentLogger;
  }

  public override async fetchModelIds(): Promise<string[]> {
    const response = await this.fetchWithTimeout(`${this.normalizedBaseUrl}/models`, {
      headers: this.authHeaders,
    });

    await this.assertSuccessfulResponse(response, 'model list request');

    const payload = (await response.json()) as { data?: { id?: unknown }[] };

    return (payload.data ?? [])
      .map(({ id }) => id)
      .filter((id): id is string => typeof id === 'string');
  }

  private get authHeaders(): Record<string, string> {
    return this.apiKey === undefined ? {} : { Authorization: `Bearer ${this.apiKey}` };
  }

  private get normalizedBaseUrl(): string {
    return this.baseUrl.replace(/\/+$/, '');
  }

  private async fetchWithTimeout(
    input: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timeoutController = this.timeoutMs === undefined ? undefined : new AbortController();
    const timeoutId =
      timeoutController === undefined
        ? undefined
        : setTimeout(() => {
            timeoutController.abort(
              new Error(`OpenAI request timed out after ${String(this.timeoutMs)}ms`),
            );
          }, this.timeoutMs);
    const signals = [signal, timeoutController?.signal].filter(
      (candidate): candidate is AbortSignal => candidate !== undefined,
    );

    try {
      try {
        return await fetch(input, {
          ...init,
          signal: signals.length === 0 ? undefined : AbortSignal.any(signals),
        });
      } catch (error) {
        // A caller abort is normal stream control flow. Everything else that
        // failed before response headers is provider-agnostic connectivity.
        if (signal?.aborted === true) throw error;

        throw createOpenAIConnectionError(error);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async assertSuccessfulResponse(response: Response, operation: string): Promise<void> {
    if (response.ok) return;

    const detail = await response.text().catch(() => '');
    throw createOpenAIError(operation, parseOpenAIErrorDetails(detail), response.status);
  }

  private async request(
    systemPrompt: string,
    messageHistory: Message[],
    tools: Tool[],
    opts: TextGenerateOptions | undefined,
    signal: AbortSignal,
  ): Promise<Response> {
    const body = this.buildBody(systemPrompt, messageHistory, tools, opts);
    const modelId = typeof body.model === 'string' ? body.model : 'unknown';
    const startedAt = Date.now();

    this.logger.debug(
      { messageCount: messageHistory.length, modelId, toolCount: tools.length },
      'Chat completion request sent.',
    );

    let response: Response;
    try {
      response = await this.fetchWithTimeout(
        `${this.normalizedBaseUrl}/chat/completions`,
        {
          body: JSON.stringify(body),
          headers: { ...this.authHeaders, 'Content-Type': 'application/json' },
          method: 'POST',
        },
        signal,
      );
    } catch (error) {
      // Timeouts and connection failures never reach a status code, so they
      // would otherwise only surface as a retry warning in the runner.
      if (!signal.aborted) {
        this.logger.error(
          {
            baseUrl: this.normalizedBaseUrl,
            durationMs: Date.now() - startedAt,
            err: error,
            modelId,
          },
          'Chat completion request never reached the provider.',
        );
      }
      throw error;
    }

    const durationMs = Date.now() - startedAt;
    if (response.ok) {
      this.logger.debug({ durationMs, modelId }, 'Chat completion response headers received.');
    } else {
      // Rate limiting is the failure an operator most needs to see coming; it
      // looks identical to any other 4xx once it becomes a thrown Error.
      const metadata = { durationMs, modelId, status: response.status };
      if (response.status === 429) {
        this.logger.warn(
          { ...metadata, retryAfter: response.headers.get('retry-after') },
          'Provider rate limited the chat completion request.',
        );
      } else {
        this.logger.error(metadata, 'Chat completion request rejected by the provider.');
      }
    }

    await this.assertSuccessfulResponse(response, 'chat completion request');
    return response;
  }

  /** Resolves the model the way `buildBody` does, so logs name the same one. */
  private resolveModel(opts: TextGenerateOptions | undefined): {
    model?: ModelConfig;
    modelId: string;
  } {
    const configuredModel =
      this.defaultModel === undefined ? undefined : this.getModelConfig(this.defaultModel);
    const model = opts?.model ?? configuredModel;
    const modelId = model?.modelId ?? this.defaultModel;

    if (modelId === undefined) {
      throw new Error('No OpenAI model configured: pass opts.model or set defaultModel.');
    }

    return { model, modelId };
  }

  private buildBody(
    systemPrompt: string,
    messageHistory: Message[],
    tools: Tool[],
    opts: TextGenerateOptions | undefined,
  ): Record<string, unknown> {
    const { model, modelId } = this.resolveModel(opts);

    const sampling = { ...model, ...opts };
    const body: Record<string, unknown> = {
      messages: this.toOpenAIMessages(systemPrompt, messageHistory),
      model: modelId,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (tools.length > 0) body.tools = this.toOpenAITools(tools);
    if (sampling.maxTokens !== undefined) body.max_completion_tokens = sampling.maxTokens;
    if (sampling.temperature !== undefined) body.temperature = sampling.temperature;
    if (sampling.topP !== undefined) body.top_p = sampling.topP;
    if (sampling.stop !== undefined) body.stop = sampling.stop;
    if (sampling.seed !== undefined) body.seed = sampling.seed;
    if (sampling.frequencyPenalty !== undefined) body.frequency_penalty = sampling.frequencyPenalty;
    if (sampling.presencePenalty !== undefined) body.presence_penalty = sampling.presencePenalty;

    return body;
  }
  private toOpenAIMessages(systemPrompt: string, history: Message[]): OpenAIMessage[] {
    const messages: OpenAIMessage[] = [{ content: systemPrompt, role: 'system' }];

    for (const message of history) {
      switch (message.role) {
        case 'user': {
          messages.push({ content: this.toOpenAIUserContent(message.content), role: 'user' });
          break;
        }
        case 'assistant': {
          messages.push({ content: this.toAssistantText(message.content), role: 'assistant' });
          break;
        }
        case 'compacted': {
          messages.push({
            content: this.toOpenAIUserContent([
              { text: COMPACTION_HEADER, type: 'text' },
              ...message.content,
            ]),
            role: 'user',
          });
          break;
        }
        case 'folded': {
          // Chat Completions has no notion of a folded turn, so the placeholder
          // rides along on the assistant turn whose tool traffic it replaced
          // rather than becoming a turn of its own and breaking alternation.
          const foldText = this.toAssistantText(message.content);
          const previous = messages.at(-1);

          if (previous?.role === 'assistant') {
            if (foldText !== null) {
              previous.content =
                previous.content === null ? foldText : `${previous.content}\n${foldText}`;
            }
          } else {
            messages.push({ content: foldText, role: 'assistant' });
          }
          break;
        }
        case 'reasoning': {
          // Never sent back: this API has no field for it, and replaying it as
          // assistant text invites the model to imitate its own scratchpad.
          break;
        }
        case 'toolCall': {
          const toolCall = this.toOpenAIToolCall(message);
          const previous = messages.at(-1);

          if (previous?.role === 'assistant') {
            previous.tool_calls = [...(previous.tool_calls ?? []), toolCall];
          } else {
            messages.push({ content: null, role: 'assistant', tool_calls: [toolCall] });
          }
          break;
        }
        case 'toolResponse': {
          const responseText = message.response
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n');

          if (message.execution === 'deferredResult') {
            // A late deferred result cannot be a `tool` message: those must sit
            // right after their tool_calls turn. Surface it as user content
            // correlated by track ID instead.
            messages.push({
              content: `[deferred result for ${message.name} (${message.trackId})]\n${responseText}`,
              role: 'user',
            });
            break;
          }

          messages.push({ content: responseText, role: 'tool', tool_call_id: message.trackId });
          break;
        }
      }
    }

    return messages;
  }

  private toOpenAIUserContent(content: readonly MessageContent[]): OpenAIContentPart[] | string {
    const parts = content.map((part): OpenAIContentPart => {
      if (part.type === 'text') return part;

      const url =
        part.source.type === 'url'
          ? part.source.url
          : `data:${part.source.mediaType};base64,${part.source.data}`;
      return { image_url: { url }, type: 'image_url' };
    });

    // A plain string is the shape every implementation of this API accepts; the
    // part array is only worth its compatibility risk when an image needs it.
    return parts.every((part) => part.type === 'text')
      ? parts.map((part) => part.text).join('')
      : parts;
  }

  private toAssistantText(content: readonly MessageContent[]): null | string {
    const text = content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
    return text.length > 0 ? text : null;
  }

  private toOpenAIToolCall(toolCall: ToolCallMessage): OpenAIToolCall {
    return {
      function: { arguments: JSON.stringify(toolCall.arguments), name: toolCall.name },
      id: toolCall.trackId,
      type: 'function',
    };
  }

  private toOpenAITools(tools: Tool[]): Record<string, unknown>[] {
    return tools.map((tool) => ({
      function: {
        description: tool.description,
        name: tool.name,
        parameters: z.toJSONSchema(tool.parameters, { io: 'input' }),
      },
      type: 'function',
    }));
  }

  private toToolCall(pending: PendingToolCall): ToolCallDraft {
    if (pending.id.length === 0 || pending.name.length === 0) {
      throw new Error('OpenAI returned an incomplete tool call.');
    }

    let parsed: unknown;
    try {
      parsed = pending.arguments.length > 0 ? JSON.parse(pending.arguments) : {};
    } catch {
      throw new Error(
        `OpenAI tool call "${pending.name}" returned invalid JSON arguments: ${pending.arguments}`,
      );
    }

    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error(`OpenAI tool call "${pending.name}" returned non-object arguments.`);
    }

    return {
      arguments: parsed as Record<string, unknown>,
      name: pending.name,
      role: 'toolCall',
      trackId: pending.id,
    };
  }

  protected override async *attempt(
    systemPrompt: string,
    messageHistory: Message[],
    tools: Tool[],
    opts: TextGenerateOptions | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderSourceEvent> {
    const startedAt = Date.now();
    const response = await this.request(systemPrompt, messageHistory, tools, opts, signal);
    if (response.body === null) throw new Error('OpenAI response did not include a body.');

    const { modelId } = this.resolveModel(opts);
    const decoder = new TextDecoder();
    const pendingToolCalls: (PendingToolCall | undefined)[] = [];
    let buffer = '';
    let usage: OpenAIUsage | undefined;

    /** Folds one `data:` payload into the accumulators; returns what to emit. */
    const consumeData = (data: string): StreamFragments => {
      if (data === '[DONE]') return { done: true };

      let chunk: OpenAIStreamChunk;
      try {
        chunk = JSON.parse(data) as OpenAIStreamChunk;
      } catch {
        throw createOpenAIError('stream', {
          message: `OpenAI returned an invalid stream event: ${data.slice(0, MAX_ERROR_DETAIL_LENGTH)}`,
        });
      }

      if (chunk.error !== undefined) {
        throw createOpenAIError('stream', {
          code: chunk.error.code,
          message: chunk.error.message ?? 'OpenAI returned a stream error',
          type: chunk.error.type,
        });
      }
      if (chunk.usage !== null && chunk.usage !== undefined) usage = chunk.usage;

      const delta = chunk.choices?.[0]?.delta;

      // Tool calls arrive as fragments keyed by index, in any interleaving.
      for (const call of delta?.tool_calls ?? []) {
        const pending = pendingToolCalls[call.index] ?? { arguments: '', id: '', name: '' };
        pendingToolCalls[call.index] = pending;

        if (call.id !== undefined) pending.id += call.id;
        if (call.function?.name !== undefined) pending.name += call.function.name;
        if (call.function?.arguments !== undefined) pending.arguments += call.function.arguments;
      }

      return {
        content: delta?.content ?? undefined,
        reasoning: delta?.reasoning_content ?? delta?.reasoning ?? undefined,
      };
    };

    let done = false;
    try {
      // `ReadableStream` iterates as `any` under these lib types; the body of
      // a fetch response is always a byte stream.
      for await (const bytes of response.body as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(bytes, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith(DATA_PREFIX)) continue;

          const fragments = consumeData(line.slice(DATA_PREFIX.length).trim());
          if (fragments.done === true) {
            done = true;
            break;
          }
          yield* emitFragments(fragments);
        }

        if (done) break;
      }
    } catch (error) {
      if (error instanceof ProviderError || signal.aborted) throw error;
      throw createOpenAIConnectionError(error, 'OpenAI stream connection failed');
    }

    // A stream that ended without `[DONE]` may still hold one buffered line.
    if (!done) {
      buffer += decoder.decode();
      const line = buffer.trim();
      if (line.startsWith(DATA_PREFIX)) {
        yield* emitFragments(consumeData(line.slice(DATA_PREFIX.length).trim()));
      }
    }

    let toolCallCount = 0;
    for (const pending of pendingToolCalls) {
      if (pending === undefined) continue;
      toolCallCount += 1;
      yield { toolCall: this.toToolCall(pending), type: 'toolCall' };
    }

    if (usage === undefined) {
      // Without usage there is no cost or context accounting for this call.
      this.logger.warn({ modelId }, 'Provider returned no usage for a chat completion.');
    } else {
      this.logger.info(
        {
          cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
          durationMs: Date.now() - startedAt,
          inputTokens: usage.prompt_tokens,
          modelId,
          outputTokens: usage.completion_tokens,
          toolCallCount,
        },
        'Chat completion finished.',
      );
    }

    yield {
      type: 'end',
      usage:
        usage === undefined
          ? undefined
          : {
              cacheReadTokens: usage.prompt_tokens_details?.cached_tokens,
              inputTokens: usage.prompt_tokens,
              outputTokens: usage.completion_tokens,
            },
    };
  }
}

export { OpenAICompletions, openAICompletionsConfigSchema };

export type { OpenAICompletionsConfig, OpenAICompletionsConfigInput, OpenAICompletionsOptions };
