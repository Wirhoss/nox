import { UNTRUSTED_FENCE_TEXT } from '@nox/extension-api';

import { toolParametersSchema } from '../../tool/render';
import { messageToString } from './message';

import type { Message, Tool } from '@nox/extension-api';

const DEFAULT_CHARACTERS_PER_TOKEN = 3;
const MESSAGE_TOKEN_OVERHEAD = 6;
const SYSTEM_TOKEN_OVERHEAD = 4;
const TOOL_TOKEN_OVERHEAD = 8;

const MEDIA_TOKEN_ESTIMATE = {
  audio: 2048,
  document: 2048,
  image: 1024,
  video: 4096,
} as const;

function estimateTokensByCharacters(text: string): number {
  return Math.ceil(text.length / DEFAULT_CHARACTERS_PER_TOKEN);
}

/**
 * Serializes with object keys in a fixed order, so the same message always
 * produces the same estimate regardless of property insertion order.
 */
function stableSerialize(value: unknown, ancestors = new Set<object>()): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return 'null';
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (ancestors.has(value)) throw new TypeError('Cannot estimate tokens for a circular value.');

  ancestors.add(value);
  const serialized = Array.isArray(value)
    ? `[${value.map((item: unknown) => stableSerialize(item, ancestors)).join(',')}]`
    : `{${Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item, ancestors)}`)
        .join(',')}}`;
  ancestors.delete(value);
  return serialized;
}

function artifactTokens(mediaType: string): number {
  if (mediaType.startsWith('audio/')) return MEDIA_TOKEN_ESTIMATE.audio;
  if (mediaType.startsWith('image/')) return MEDIA_TOKEN_ESTIMATE.image;
  if (mediaType.startsWith('video/')) return MEDIA_TOKEN_ESTIMATE.video;
  return MEDIA_TOKEN_ESTIMATE.document;
}

function mediaTokens(message: Message): number {
  const content =
    message.role === 'toolResponse'
      ? message.response
      : message.role === 'toolCall'
        ? []
        : message.content;
  return content.reduce((total, part) => {
    if (part.type === 'text') return total;
    return (
      total +
      (part.type === 'artifact'
        ? artifactTokens(part.artifact.mediaType)
        : MEDIA_TOKEN_ESTIMATE[part.type])
    );
  }, 0);
}

class TokenEstimator {
  readonly #cache = new WeakMap<Message, number>();
  readonly #count: (text: string) => number;
  readonly #fenceTokens: number;
  readonly #prefixTokens: number;

  constructor(
    systemPrompt: string,
    tools: Iterable<Tool>,
    tokenCounter: (text: string) => number = estimateTokensByCharacters,
  ) {
    this.#count = tokenCounter;
    // Untrusted tool output is fenced on its way to a provider, not in storage,
    // so the fence is real cost this would otherwise never see.
    this.#fenceTokens = this.#countText(UNTRUSTED_FENCE_TEXT);
    this.#prefixTokens =
      this.#countText(stableSerialize({ content: systemPrompt, role: 'system' })) +
      SYSTEM_TOKEN_OVERHEAD +
      [...tools].reduce((total, tool) => total + this.#estimateTool(tool), 0);
  }

  public get prefixTokens(): number {
    return this.#prefixTokens;
  }

  public estimateHistory(history: readonly Message[]): number {
    return history.reduce(
      (total, message) => total + this.estimateMessage(message),
      this.#prefixTokens,
    );
  }

  public estimateMessage(message: Message): number {
    const cached = this.#cache.get(message);
    if (cached !== undefined) return cached;

    const estimate =
      Math.max(
        this.#countText(stableSerialize(message)),
        this.#countText(messageToString(message)),
      ) +
      mediaTokens(message) +
      MESSAGE_TOKEN_OVERHEAD +
      (message.role === 'toolResponse' && message.trust === 'untrusted' ? this.#fenceTokens : 0);

    if (Object.isFrozen(message)) this.#cache.set(message, estimate);
    return estimate;
  }

  #countText(text: string): number {
    const count = this.#count(text);
    if (!Number.isFinite(count) || count < 0) {
      throw new RangeError('tokenCounter must return a finite, non-negative number.');
    }
    return Math.ceil(count);
  }

  #estimateTool(tool: Tool): number {
    const descriptor = {
      function: {
        description: tool.description,
        name: tool.name,
        parameters: toolParametersSchema(tool),
      },
      type: 'function',
    };
    return this.#countText(stableSerialize(descriptor)) + TOOL_TOKEN_OVERHEAD;
  }
}

export { estimateTokensByCharacters, TokenEstimator };
