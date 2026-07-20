import { z } from 'zod';

import {
  providerBaseConfigSchema,
  type TextGenerateOptions,
} from '../config';
import {
  BaseProvider,
  type ChatProvider,
} from '../provider';
import {
  ProviderStream,
  type ProviderStreamEvent,
} from '../stream';

import type { Tool } from '../../tool';
import type {
  Message,
  MessageContent,
  ToolCallMessage,
} from '../message';

const openAICompletionsConfigSchema = providerBaseConfigSchema.extend({
  type: z.literal('openai_completions'),
  defaultModel: z.string().min(1).optional(),
});

type OpenAICompletionsConfig = z.infer<typeof openAICompletionsConfigSchema>;

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    arguments: string;
    name: string;
  };
}

type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OpenAIContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

interface OpenAIUsage {
  completion_tokens: number;
  prompt_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

interface OpenAIStreamDelta {
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: {
      arguments?: string;
      name?: string;
    };
  }>;
}

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: OpenAIStreamDelta;
  }>;
  error?: {
    message?: string;
  };
  usage?: OpenAIUsage | null;
}

interface PendingToolCall {
  arguments: string;
  id: string;
  name: string;
}

class OpenAICompletions extends BaseProvider implements ChatProvider {
  static override readonly configSchema = openAICompletionsConfigSchema;

  private readonly defaultModel?: string;

  constructor(config: OpenAICompletionsConfig) {
    super(config);
    this.defaultModel = config.defaultModel;
  }

  public override async fetchModelIds(): Promise<string[]> {
    const response = await this.fetchWithTimeout(
      `${this.normalizedBaseUrl}/models`,
      {
        headers: this.authHeaders,
      },
    );

    await this.assertSuccessfulResponse(response, 'model list request');

    const payload = await response.json() as {
      data?: Array<{ id?: unknown }>;
    };

    return (payload.data ?? [])
      .map(({ id }) => id)
      .filter((id): id is string => typeof id === 'string');
  }

  public getMessageStream(
    systemPrompt: string,
    messageHistory: Message[],
    tools: Tool[],
    opts?: TextGenerateOptions,
  ): ProviderStream {
    const signal = opts?.signal ?? new AbortController().signal;

    return new ProviderStream(
      this.readStream(systemPrompt, messageHistory, tools, opts, signal),
      signal,
    );
  }

  private get authHeaders(): Record<string, string> {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }

  private get normalizedBaseUrl(): string {
    return this.baseUrl.replace(/\/+$/, '');
  }

  private async fetchWithTimeout(
    input: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timeoutController = this.timeoutMs === undefined
      ? undefined
      : new AbortController();
    const timeoutId = timeoutController === undefined
      ? undefined
      : setTimeout(
        () => timeoutController.abort(
          new Error(`OpenAI request timed out after ${this.timeoutMs}ms`),
        ),
        this.timeoutMs,
      );
    const signals = [signal, timeoutController?.signal]
      .filter((candidate): candidate is AbortSignal => candidate !== undefined);

    try {
      return await fetch(input, {
        ...init,
        signal: signals.length === 0
          ? undefined
          : signals.length === 1
            ? signals[0]
            : AbortSignal.any(signals),
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async assertSuccessfulResponse(response: Response, operation: string): Promise<void> {
    if (response.ok) return;

    const detail = await response.text().catch(() => '');
    const suffix = detail.length > 0 ? `: ${detail.slice(0, 500)}` : '';
    throw new Error(`OpenAI ${operation} failed (${response.status})${suffix}`);
  }

  private async request(
    systemPrompt: string,
    messageHistory: Message[],
    tools: Tool[],
    opts: TextGenerateOptions | undefined,
    signal: AbortSignal,
  ): Promise<Response> {
    const response = await this.fetchWithTimeout(
      `${this.normalizedBaseUrl}/chat/completions`,
      {
        body: JSON.stringify(this.buildBody(systemPrompt, messageHistory, tools, opts)),
        headers: {
          ...this.authHeaders,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      },
      signal,
    );

    await this.assertSuccessfulResponse(response, 'chat completion request');
    return response;
  }

  private buildBody(
    systemPrompt: string,
    messageHistory: Message[],
    tools: Tool[],
    opts: TextGenerateOptions | undefined,
  ): Record<string, unknown> {
    const configuredModel = this.defaultModel === undefined
      ? undefined
      : this.getModelConfig(this.defaultModel);
    const model = opts?.model ?? configuredModel;
    const modelId = model?.modelId ?? this.defaultModel;

    if (modelId === undefined) {
      throw new Error('No OpenAI model configured: pass opts.model or set defaultModel');
    }

    const sampling = { ...model, ...opts };
    const body: Record<string, unknown> = {
      messages: this.toOpenAIMessages(systemPrompt, messageHistory),
      model: modelId,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (tools.length > 0) body.tools = this.toOpenAITools(tools);
    if (sampling.maxTokens !== undefined) {
      body.max_completion_tokens = sampling.maxTokens;
    }
    if (sampling.temperature !== undefined) body.temperature = sampling.temperature;
    if (sampling.topP !== undefined) body.top_p = sampling.topP;
    if (sampling.stop !== undefined) body.stop = sampling.stop;
    if (sampling.seed !== undefined) body.seed = sampling.seed;
    if (sampling.frequencyPenalty !== undefined) {
      body.frequency_penalty = sampling.frequencyPenalty;
    }
    if (sampling.presencePenalty !== undefined) {
      body.presence_penalty = sampling.presencePenalty;
    }

    return body;
  }

  private toOpenAIMessages(systemPrompt: string, history: Message[]): OpenAIMessage[] {
    const messages: OpenAIMessage[] = [
      { content: systemPrompt, role: 'system' },
    ];

    for (const message of history) {
      if (message.role === 'user') {
        messages.push({
          content: this.toOpenAIUserContent(message.content),
          role: 'user',
        });
        continue;
      }

      if (message.role === 'assistant') {
        messages.push({
          content: this.toAssistantText(message.content),
          role: 'assistant',
        });
        continue;
      }

      if (message.role === 'toolCall') {
        const toolCall = this.toOpenAIToolCall(message);
        const previous = messages.at(-1);

        if (previous?.role === 'assistant') {
          previous.tool_calls = [...(previous.tool_calls ?? []), toolCall];
        } else {
          messages.push({
            content: null,
            role: 'assistant',
            tool_calls: [toolCall],
          });
        }
        continue;
      }

      const responseText = message.response
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');

      if (message.execution === 'deferredResult') {
        // A late deferred result can't be a `tool` message: those must sit
        // right after their tool_calls turn. Surface it as user content
        // correlated by trackId instead.
        messages.push({
          content: `[deferred result for ${message.name} (${message.trackId})]\n${responseText}`,
          role: 'user',
        });
        continue;
      }

      messages.push({
        content: responseText,
        role: 'tool',
        tool_call_id: message.trackId,
      });
    }

    return messages;
  }

  private toOpenAIUserContent(content: MessageContent[]): string | OpenAIContentPart[] {
    const parts = content.map((part): OpenAIContentPart => {
      if (part.type === 'text') return part;

      const url = part.source.kind === 'url'
        ? part.source.url
        : `data:${part.source.mediaType};base64,${part.source.data}`;
      return { image_url: { url }, type: 'image_url' };
    });

    return parts.every((part) => part.type === 'text')
      ? parts.map((part) => part.type === 'text' ? part.text : '').join('')
      : parts;
  }

  private toAssistantText(content: MessageContent[]): string | null {
    const text = content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
    return text.length > 0 ? text : null;
  }

  private toOpenAIToolCall(toolCall: ToolCallMessage): OpenAIToolCall {
    return {
      function: {
        arguments: JSON.stringify(toolCall.arguments),
        name: toolCall.name,
      },
      id: toolCall.trackId,
      type: 'function',
    };
  }

  private toOpenAITools(tools: Tool[]): Array<Record<string, unknown>> {
    return tools.map((tool) => ({
      function: {
        description: tool.description,
        name: tool.name,
        parameters: z.toJSONSchema(tool.parameters, { io: 'input' }),
      },
      type: 'function',
    }));
  }

  private toToolCall(pending: PendingToolCall): ToolCallMessage {
    if (pending.id.length === 0 || pending.name.length === 0) {
      throw new Error('OpenAI returned an incomplete tool call');
    }

    let parsed: unknown;
    try {
      parsed = pending.arguments.length > 0
        ? JSON.parse(pending.arguments)
        : {};
    } catch {
      throw new Error(
        `OpenAI tool call "${pending.name}" returned invalid JSON arguments: ${pending.arguments}`,
      );
    }

    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error(
        `OpenAI tool call "${pending.name}" returned non-object arguments`,
      );
    }

    return {
      arguments: parsed as Record<string, unknown>,
      name: pending.name,
      role: 'toolCall',
      trackId: pending.id,
    };
  }

  private async *readStream(
    systemPrompt: string,
    messageHistory: Message[],
    tools: Tool[],
    opts: TextGenerateOptions | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderStreamEvent> {
    const response = await this.request(systemPrompt, messageHistory, tools, opts, signal);
    if (response.body === null) throw new Error('OpenAI response did not include a body');

    const decoder = new TextDecoder();
    const pendingToolCalls: Array<PendingToolCall | undefined> = [];
    let buffer = '';
    let text = '';
    let usage: OpenAIUsage | undefined;

    const consumeData = (data: string): string | undefined => {
      if (data === '[DONE]') return data;

      let chunk: OpenAIStreamChunk;
      try {
        chunk = JSON.parse(data) as OpenAIStreamChunk;
      } catch {
        throw new Error(`OpenAI returned an invalid stream event: ${data.slice(0, 500)}`);
      }

      if (chunk.error !== undefined) {
        throw new Error(chunk.error.message ?? 'OpenAI returned a stream error');
      }
      if (chunk.usage !== null && chunk.usage !== undefined) usage = chunk.usage;

      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) text += delta.content;

      for (const call of delta?.tool_calls ?? []) {
        const pending = pendingToolCalls[call.index] ?? {
          arguments: '',
          id: '',
          name: '',
        };
        pendingToolCalls[call.index] = pending;

        if (call.id !== undefined) pending.id += call.id;
        if (call.function?.name !== undefined) pending.name += call.function.name;
        if (call.function?.arguments !== undefined) {
          pending.arguments += call.function.arguments;
        }
      }

      return delta?.content ?? undefined;
    };

    let done = false;
    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;

        const fragment = consumeData(line.slice(5).trim());
        if (fragment === '[DONE]') {
          done = true;
          break;
        }
        if (fragment) yield { text: fragment, type: 'textFragment' };
      }

      if (done) break;
    }

    if (!done) {
      buffer += decoder.decode();
      const line = buffer.trim();
      if (line.startsWith('data:')) {
        const fragment = consumeData(line.slice(5).trim());
        if (fragment && fragment !== '[DONE]') {
          yield { text: fragment, type: 'textFragment' };
        }
      }
    }

    const messages: Message[] = [];
    if (text.length > 0) {
      messages.push({
        content: [{ text, type: 'text' }],
        role: 'assistant',
      });
    }

    for (const pending of pendingToolCalls) {
      if (pending === undefined) continue;
      const toolCall = this.toToolCall(pending);
      messages.push(toolCall);
      yield { toolCall, type: 'toolCall' };
    }

    yield {
      messages,
      type: 'end',
      usage: usage === undefined
        ? undefined
        : {
          cacheReadTokens: usage.prompt_tokens_details?.cached_tokens,
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
        },
    };
  }
}

export {
  OpenAICompletions,
  openAICompletionsConfigSchema,
};

export type {
  OpenAICompletionsConfig,
};
