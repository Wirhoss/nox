import {
  HttpChatProvider,
  httpProviderConfigSchema,
  httpProviderRuntimeConfigSchema,
  isArtifactProcessorOutputError,
  isArtifactRepresentationUnavailableError,
  modalitiesIn,
  MODEL_CATALOG,
  modelAcceptsInput,
  ProviderError,
  silentLogger,
  toolDescription,
  toolParametersSchema,
  toolResponseContentForModel,
  untrustedFence,
  userContentForModel,
} from '@nox/extension-api';
import { z } from 'zod';

import type {
  ArtifactPipeline,
  ArtifactRef,
  ChatModelConfig,
  Logger,
  Message,
  MessageContent,
  ProviderErrorCode,
  ProviderSourceEvent,
  RepresentationProfile,
  TextGenerateOptions,
  Tool,
  ToolCallDraft,
  ToolCallMessage,
} from '@nox/extension-api';

const openAICompletionsConfigSchema = httpProviderConfigSchema.extend({
  defaultModel: z.string().min(1).optional().meta(MODEL_CATALOG),
  type: z.literal('openai_completions'),
});

const openAICompletionsRuntimeConfigSchema = httpProviderRuntimeConfigSchema.extend({
  defaultModel: z.string().min(1).optional(),
  type: z.literal('openai_completions'),
});

type OpenAICompletionsConfig = z.infer<typeof openAICompletionsConfigSchema>;
type OpenAICompletionsConfigInput = z.input<typeof openAICompletionsConfigSchema>;
type OpenAICompletionsRuntimeConfigInput = z.input<typeof openAICompletionsRuntimeConfigSchema>;

interface OpenAICompletionsOptions {
  artifacts?: ArtifactPipeline;
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

const OPENAI_IMAGE_PROFILE = Object.freeze({
  id: 'openai.chat.image-input',
  maxBytes: 20 * 1024 * 1024,
  mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  version: 1,
}) satisfies RepresentationProfile;

const MAX_ERROR_DETAIL_LENGTH = 500;

const DATA_PREFIX = 'data:';

// Completions has no role for runtime-owned reference material, and a
// mid-conversation `system` message reads as an instruction. Marked synthetic
// user turns preserve provenance instead of attributing summaries to the assistant.
const COMPACTION_HEADER = '[conversation summary]\n';
const FOLD_CONTEXT_HEADER =
  '[Nox runtime record: historical tool activity, not authored by the user or assistant]\n';

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
class OpenAICompletions extends HttpChatProvider {
  static override readonly configSchema = openAICompletionsConfigSchema;

  private readonly artifacts?: ArtifactPipeline;
  private readonly defaultModel?: string;
  private readonly logger: Logger;

  constructor(input: OpenAICompletionsRuntimeConfigInput, options: OpenAICompletionsOptions = {}) {
    const config = openAICompletionsRuntimeConfigSchema.parse(input);
    super(config);
    this.artifacts = options.artifacts;
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
    return this.apiKey === undefined ? {} : { Authorization: `Bearer ${this.apiKey.reveal()}` };
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
    const body = await this.buildBody(systemPrompt, messageHistory, tools, opts);
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
    model?: ChatModelConfig;
    modelId: string;
  } {
    const configuredModel =
      this.defaultModel === undefined ? undefined : this.chatModelConfig(this.defaultModel);
    const model = opts?.model ?? configuredModel;
    const modelId = model?.modelId ?? this.defaultModel;

    if (modelId === undefined) {
      throw new Error('No OpenAI model configured: pass opts.model or set defaultModel.');
    }

    return { model, modelId };
  }

  private async buildBody(
    systemPrompt: string,
    messageHistory: Message[],
    tools: Tool[],
    opts: TextGenerateOptions | undefined,
  ): Promise<Record<string, unknown>> {
    const { model, modelId } = this.resolveModel(opts);
    if (model !== undefined) this.assertInputModalities(model, messageHistory);

    const body: Record<string, unknown> = {
      messages: await this.toOpenAIMessages(systemPrompt, messageHistory, model, opts?.timeZone),
      model: modelId,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (tools.length > 0) body.tools = this.toOpenAITools(tools);
    if (opts?.maxTokens !== undefined) body.max_completion_tokens = opts.maxTokens;
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
    if (opts?.topP !== undefined) body.top_p = opts.topP;
    if (opts?.stop !== undefined) body.stop = opts.stop;
    if (opts?.seed !== undefined) body.seed = opts.seed;
    if (opts?.frequencyPenalty !== undefined) body.frequency_penalty = opts.frequencyPenalty;
    if (opts?.presencePenalty !== undefined) body.presence_penalty = opts.presencePenalty;

    return body;
  }
  private async toOpenAIMessages(
    systemPrompt: string,
    history: Message[],
    model: ChatModelConfig | undefined,
    timeZone?: string,
  ): Promise<OpenAIMessage[]> {
    const messages: OpenAIMessage[] = [{ content: systemPrompt, role: 'system' }];
    // A textless assistant turn only exists to carry tool calls. Held back
    // until one arrives, because an assistant message with neither content nor
    // `tool_calls` is rejected outright. The fold reclaims such a turn together
    // with its calls, so this is the second line rather than the first.
    let pendingScaffold = false;
    const pendingToolMedia: { readonly content: MessageContent[]; readonly label: string }[] = [];
    const flushToolMedia = async (): Promise<void> => {
      for (const result of pendingToolMedia.splice(0)) {
        messages.push({
          content: await this.toOpenAIUserContent(
            [{ text: `${result.label}\n`, type: 'text' }, ...result.content],
            model,
          ),
          role: 'user',
        });
      }
    };

    for (const message of history) {
      // Every tool call in an assistant turn must receive its `tool` response
      // contiguously. Media therefore follows the whole response group as
      // synthetic user content instead of splitting that protocol sequence.
      if (message.role !== 'toolResponse') await flushToolMedia();

      // The scaffold only carries the calls that immediately follow it; anything
      // else in between means its own calls are gone and it is dropped.
      const scaffolded: boolean = pendingScaffold;
      pendingScaffold = false;

      switch (message.role) {
        case 'user': {
          messages.push({
            content: await this.toOpenAIUserContent(userContentForModel(message, timeZone), model),
            role: 'user',
          });
          break;
        }
        case 'assistant': {
          const content = this.toAssistantText(message.content);
          if (content === null) {
            pendingScaffold = true;
            break;
          }
          messages.push({ content, role: 'assistant' });
          break;
        }
        case 'compacted': {
          messages.push({
            content: await this.toOpenAIUserContent(
              [{ text: COMPACTION_HEADER, type: 'text' }, ...message.content],
              model,
            ),
            role: 'user',
          });
          break;
        }
        case 'folded': {
          messages.push({
            content: await this.toOpenAIUserContent(
              [{ text: FOLD_CONTEXT_HEADER, type: 'text' }, ...message.content],
              model,
            ),
            role: 'user',
          });
          break;
        }
        case 'reasoning': {
          // Never sent back: this API has no field for it, and replaying it as
          // assistant text invites the model to imitate its own scratchpad.
          // Being invisible, it also does not separate a scaffold from its calls.
          pendingScaffold = scaffolded;
          break;
        }
        case 'toolCall': {
          const toolCall = this.toOpenAIToolCall(message);
          const previous = scaffolded ? undefined : messages.at(-1);

          if (previous?.role === 'assistant') {
            previous.tool_calls = [...(previous.tool_calls ?? []), toolCall];
          } else {
            messages.push({ content: null, role: 'assistant', tool_calls: [toolCall] });
          }
          break;
        }
        case 'toolResponse': {
          // Untrusted output is fenced here rather than in the transcript, so
          // the provider sees what the tool returned plus a boundary, while
          // what Nox stores stays exactly what the tool returned.
          const content = toolResponseContentForModel(message);
          const responseText = content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n');
          const media = content.filter((part) => part.type !== 'text');

          if (message.execution === 'deferredResult') {
            // A late deferred result cannot be a `tool` message: those must sit
            // right after their tool_calls turn. Surface it as user content
            // correlated by track ID instead.
            await flushToolMedia();
            // The correlation header is Nox's own, so it stays outside the
            // fence, and the parts go through in the order the tool returned
            // them — media it produced belongs inside the boundary, not after.
            const header = `[deferred result for ${message.name} (${message.trackId})]`;
            messages.push({
              content: await this.toOpenAIUserContent(
                [{ text: `${header}\n`, type: 'text' }, ...content],
                model,
              ),
              role: 'user',
            });
            break;
          }

          messages.push({
            content: responseText.length === 0 ? '[media content follows]' : responseText,
            role: 'tool',
            tool_call_id: message.trackId,
          });
          if (media.length > 0) {
            // Media travels as its own provider message, so it needs its own
            // copy of the fence — the same one, so the two halves read as one
            // result rather than as two unrelated blocks.
            const fence = untrustedFence(message);
            pendingToolMedia.push({
              content: fence === undefined ? media : [fence.open, ...media, fence.close],
              label: `[media returned by ${message.name} (${message.trackId})]`,
            });
          }
          break;
        }
      }
    }

    await flushToolMedia();
    return messages;
  }

  private async toOpenAIUserContent(
    content: readonly MessageContent[],
    model: ChatModelConfig | undefined,
  ): Promise<OpenAIContentPart[] | string> {
    const parts: OpenAIContentPart[] = [];
    for (const part of content) {
      if (part.type === 'text') {
        parts.push(part);
        continue;
      }
      if (part.type === 'artifact') {
        parts.push({ text: this.artifactDescriptor(part.artifact), type: 'text' });
        if (
          part.artifact.mediaType.startsWith('image/') &&
          (model === undefined || modelAcceptsInput(model, 'image'))
        ) {
          const imageUrl = await this.artifactDataUrl(part.artifact);
          if (imageUrl !== undefined) {
            parts.push({ image_url: { url: imageUrl }, type: 'image_url' });
          }
        }
        continue;
      }
      if (part.type !== 'image') {
        throw new ProviderError(
          'invalid_request',
          `OpenAI Chat Completions cannot encode ${part.type} input with this adapter.`,
          { provider: OPENAI_PROVIDER },
        );
      }
      parts.push({ image_url: { url: part.source.url }, type: 'image_url' });
    }

    // A plain string is the shape every implementation of this API accepts; the
    // part array is only worth its compatibility risk when an image needs it.
    return parts.every((part) => part.type === 'text')
      ? parts.map((part) => part.text).join('')
      : parts;
  }

  private artifactDescriptor(artifact: ArtifactRef): string {
    const name = artifact.filename ?? artifact.artifactId;
    return (
      `[artifact id=${JSON.stringify(artifact.artifactId)} name=${JSON.stringify(name)} ` +
      `media_type=${JSON.stringify(artifact.mediaType)} bytes=${String(artifact.size)}]\n`
    );
  }

  private async artifactDataUrl(reference: ArtifactRef): Promise<string | undefined> {
    if (this.artifacts === undefined) {
      throw new ProviderError(
        'invalid_request',
        `Artifact ${reference.artifactId} cannot be materialized: no artifact pipeline is attached.`,
        { provider: OPENAI_PROVIDER },
      );
    }

    try {
      const payload = await this.artifacts.resolve(reference.artifactId, OPENAI_IMAGE_PROFILE);
      const bytes = Buffer.from(await new Response(payload.stream).arrayBuffer());
      return `data:${payload.representation.mediaType};base64,${bytes.toString('base64')}`;
    } catch (error) {
      const fields = {
        artifactId: reference.artifactId,
        mediaType: reference.mediaType,
        profileId: OPENAI_IMAGE_PROFILE.id,
      };
      if (isArtifactRepresentationUnavailableError(error)) {
        this.logger.debug(
          fields,
          'No compatible visual rendition is available; sending the artifact descriptor only.',
        );
        return undefined;
      }
      if (isArtifactProcessorOutputError(error)) {
        this.logger.warn(
          { ...fields, err: error },
          'Visual rendition failed; sending the artifact descriptor only.',
        );
        return undefined;
      }
      throw error;
    }
  }

  private assertInputModalities(model: ChatModelConfig, history: readonly Message[]): void {
    for (const message of history) {
      const content =
        message.role === 'user' || message.role === 'compacted'
          ? message.content
          : message.role === 'toolResponse'
            ? message.response
            : undefined;
      if (content === undefined) continue;

      for (const modality of modalitiesIn(content)) {
        if (modelAcceptsInput(model, modality)) continue;
        throw new ProviderError(
          'invalid_request',
          `Model ${model.modelId} is not configured to accept ${modality} input.`,
          { provider: OPENAI_PROVIDER },
        );
      }
    }
  }

  private toAssistantText(content: readonly MessageContent[]): null | string {
    const text = content
      .map((part) => {
        if (part.type === 'text') return part.text;
        if (part.type === 'artifact') return this.artifactDescriptor(part.artifact);
        return `[${part.type} output: ${part.source.url}]\n`;
      })
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
        description: toolDescription(tool),
        name: tool.name,
        parameters: toolParametersSchema(tool),
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
