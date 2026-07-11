import { z } from "zod";

import { isAbortError } from "../utils";

import { MessageContentStream } from "./messageContentStream";
import { BaseProvider, providerBaseConfigSchema } from "./provider";

import type {
  Message,
  MessageContent,
  MessageContentToolCall,
  MessageContentStreamEvent,
  Tool,
  Usage,
} from "../types";
import type { ChatProvider, TextGenerateOptions } from "./provider";

const openAICompletionsConfigSchema = providerBaseConfigSchema.extend({
  type: z.literal("openai_completions"),
  defaultModel: z.string().optional(),
});

type OpenAICompletionsConfig = z.infer<typeof openAICompletionsConfigSchema>;

type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | OpenAIContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface OpenAIStreamDelta {
  content?: string | null;
  tool_calls?: {
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
}

class OpenAICompletions extends BaseProvider implements ChatProvider {
  static override readonly configSchema = openAICompletionsConfigSchema;

  private defaultModel?: string;

  constructor(config: OpenAICompletionsConfig) {
    super(config);
    this.defaultModel = config.defaultModel;
  }

  public override async fetchModels(): Promise<string[]> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let signal: AbortSignal | undefined;
    if (this.timeoutMs !== undefined) {
      const timeout = new AbortController();
      timeoutId = setTimeout(
        () => timeout.abort(new Error(`no response after ${this.timeoutMs}ms`)),
        this.timeoutMs,
      );
      signal = timeout.signal;
    }

    try {
      const response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/models`, {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`model list request failed (${response.status}): ${detail.slice(0, 500)}`);
      }
      const parsed = await response.json() as { data?: { id?: string }[] };
      return (parsed.data ?? [])
        .map((entry) => entry.id)
        .filter((id) => typeof id === "string");
    } finally {
      clearTimeout(timeoutId);
    }
  }

  public getMessageStream(
    systemPrompt: string,
    messageHistory: Message[],
    tools: Tool[],
    opts?: TextGenerateOptions,
  ): MessageContentStream {
    const controller = new AbortController();
    return new MessageContentStream(
      this.readStream(systemPrompt, messageHistory, tools, opts, controller.signal),
      opts?.signal,
    );
  }

  private async request(
    systemPrompt: string,
    messageHistory: Message[],
    tools: Tool[],
    opts: TextGenerateOptions | undefined,
    extraSignal: AbortSignal,
  ): Promise<Response> {
    const signals: AbortSignal[] = [extraSignal];
    if (opts?.signal) signals.push(opts.signal);

    // timeoutMs limits time-to-first-response; once headers arrive it no longer applies
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (this.timeoutMs !== undefined) {
      const timeout = new AbortController();
      timeoutId = setTimeout(
        () => timeout.abort(new Error(`no response after ${this.timeoutMs}ms`)),
        this.timeoutMs,
      );
      signals.push(timeout.signal);
    }

    try {
      const response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(this.buildBody(systemPrompt, messageHistory, tools, opts)),
        signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`request failed (${response.status}): ${detail.slice(0, 500)}`);
      }
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private buildBody(
    systemPrompt: string,
    messageHistory: Message[],
    tools: Tool[],
    opts: TextGenerateOptions | undefined,
  ): Record<string, unknown> {
    const modelId = opts?.model?.modelId ?? this.defaultModel;
    if (!modelId) throw new Error("no model: pass opts.model or defaultModel in the config");

    // sampling parameters set directly on opts override the model's defaults
    const sampling = { ...opts?.model, ...opts };

    const body: Record<string, unknown> = {
      model: modelId,
      messages: this.toOpenAIMessages(systemPrompt, messageHistory),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools.length > 0) body.tools = this.toOpenAITools(tools);
    if (sampling.maxTokens !== undefined) body.max_tokens = sampling.maxTokens;
    if (sampling.temperature !== undefined) body.temperature = sampling.temperature;
    if (sampling.topP !== undefined) body.top_p = sampling.topP;
    if (sampling.stop !== undefined) body.stop = sampling.stop;
    if (sampling.seed !== undefined) body.seed = sampling.seed;
    if (sampling.frequencyPenalty !== undefined) body.frequency_penalty = sampling.frequencyPenalty;
    if (sampling.presencePenalty !== undefined) body.presence_penalty = sampling.presencePenalty;
    // topK does not exist in the OpenAI API; it is ignored
    return body;
  }

  private toOpenAIMessages(systemPrompt: string, messageHistory: Message[]): OpenAIMessage[] {
    const messages: OpenAIMessage[] = [{ role: "system", content: systemPrompt }];

    for (const message of messageHistory) {
      if (message.role === "assistant") {
        let text = "";
        const toolCalls: OpenAIToolCall[] = [];
        for (const block of message.content) {
          if (block.type === "text") text += block.text;
          else if (block.type === "tool_call") {
            toolCalls.push({
              id: block.trackId,
              type: "function",
              function: { name: block.name, arguments: JSON.stringify(block.arguments) },
            });
          }
        }
        messages.push({
          role: "assistant",
          content: text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
        continue;
      }

      // tool_responses go as role:"tool" messages right after the assistant
      for (const block of message.content) {
        if (block.type !== "tool_response") continue;
        messages.push({
          role: "tool",
          tool_call_id: block.trackId,
          content: block.response
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
        });
      }

      const parts: OpenAIContentPart[] = [];
      for (const block of message.content) {
        if (block.type === "text") {
          parts.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
          const url = block.source.kind === "url"
            ? block.source.url
            : `data:${block.source.mediaType};base64,${block.source.data}`;
          parts.push({ type: "image_url", image_url: { url } });
        }
      }
      if (parts.length > 0) {
        const onlyText = parts.every((part) => part.type === "text");
        messages.push({
          role: "user",
          content: onlyText
            ? parts.map((part) => (part.type === "text" ? part.text : "")).join("")
            : parts,
        });
      }
    }

    const merged: OpenAIMessage[] = [];
    for (const msg of messages) {
      const prev = merged[merged.length - 1];
      if (msg.role === "assistant" && prev?.role === "assistant") {
        prev.content = [prev.content, msg.content].filter(Boolean).join("");
        if (msg.tool_calls) {
          prev.tool_calls = [...(prev.tool_calls ?? []), ...msg.tool_calls];
        }
        continue;
      }
      merged.push(msg);
    }
    return merged;
  }

  private toOpenAITools(tools: Tool[]) {
    return tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: this.toJsonSchema(tool.parameters),
      },
    }));
  }

  private toJsonSchema(parameters: z.ZodObject): Record<string, unknown> {
    return parameters.toJSONSchema() as Record<string, unknown>;
  }

  private toToolCall(trackId: string, name: string, rawArguments: string): MessageContentToolCall {
    let parsed: Record<string, unknown>;
    try {
      parsed = rawArguments ? JSON.parse(rawArguments) : {};
    } catch {
      throw new Error(`tool call "${name}" with unreadable arguments: ${rawArguments}`);
    }
    return { type: "tool_call", name, trackId, arguments: parsed };
  }

  private async *readStream(
    systemPrompt: string,
    messageHistory: Message[],
    tools: Tool[],
    opts: TextGenerateOptions | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<MessageContentStreamEvent> {
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let aborted = false;
    let usage: Usage | undefined;

    const pendingCalls: { id: string; name: string; arguments: string }[] = [];

    try {
      const response = await this.request(systemPrompt, messageHistory, tools, opts, signal);
      if (!response.body) throw new Error("response without body");

      outer: for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") break outer;

          const parsed = JSON.parse(data) as { choices?: { delta?: OpenAIStreamDelta }[], usage?: OpenAIUsage | null; };
          if (parsed.usage) {
            usage = {
              inputTokens: parsed.usage.prompt_tokens,
              outputTokens: parsed.usage.completion_tokens,
              cacheReadTokens: parsed.usage.prompt_tokens_details?.cached_tokens,
            };
          }
          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            text += delta.content;
            yield { type: "text", text: delta.content };
          }
          for (const call of delta.tool_calls ?? []) {
            const slot = (pendingCalls[call.index] ??= { id: "", name: "", arguments: "" });
            if (call.id) slot.id = call.id;
            if (call.function?.name) slot.name += call.function.name;
            if (call.function?.arguments) slot.arguments += call.function.arguments;
          }
        }
      }
    } catch (e) {
      if (!isAbortError(e)) throw e;
      aborted = true;
    }

    const content: MessageContent[] = [];
    if (text) content.push({ type: "text", text });
    if (!aborted) {
      // on abort, pending tool calls are dropped: their arguments are truncated JSON
      for (const slot of pendingCalls) {
        if (!slot) continue;
        const toolCall = this.toToolCall(slot.id, slot.name, slot.arguments);
        content.push(toolCall);
        yield { type: "toolCall", toolCall };
      }
    }
    yield { type: "end", content, aborted, usage };
  }
}

export { OpenAICompletions };