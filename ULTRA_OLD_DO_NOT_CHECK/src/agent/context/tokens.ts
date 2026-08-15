import { z } from 'zod';

import { messageToString } from '../../provider';

import type { Message } from '../../provider';
import type { Tool } from '../../tool';

const DEFAULT_CHARACTERS_PER_TOKEN = 3;
const MESSAGE_TOKEN_OVERHEAD = 6;
const SYSTEM_TOKEN_OVERHEAD = 4;
const TOOL_TOKEN_OVERHEAD = 8;

function estimateTokensByCharacters(text: string): number {
  return Math.ceil(text.length / DEFAULT_CHARACTERS_PER_TOKEN);
}

function stableSerialize(value: unknown, ancestors = new Set<object>()): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (ancestors.has(value)) throw new TypeError('Cannot estimate tokens for a circular value.');

  ancestors.add(value);
  const serialized = Array.isArray(value)
    ? `[${value.map((item) => stableSerialize(item, ancestors)).join(',')}]`
    : `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item, ancestors)}`)
      .join(',')}}`;
  ancestors.delete(value);
  return serialized;
}

class TokenEstimator {
  readonly #cache = new WeakMap<Message, number>();
  readonly #count: (text: string) => number;
  readonly #prefixTokens: number;

  constructor(
    systemPrompt: string,
    tools: Iterable<Tool>,
    tokenCounter: (text: string) => number = estimateTokensByCharacters,
  ) {
    this.#count = tokenCounter;
    this.#prefixTokens = this.#countText(stableSerialize({ content: systemPrompt, role: 'system' }))
      + SYSTEM_TOKEN_OVERHEAD
      + [...tools].reduce((total, tool) => total + this.#estimateTool(tool), 0);
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

    const estimate = Math.max(
      this.#countText(stableSerialize(message)),
      this.#countText(messageToString(message)),
    ) + MESSAGE_TOKEN_OVERHEAD;

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
        parameters: z.toJSONSchema(tool.parameters, { io: 'input' }),
      },
      type: 'function',
    };
    return this.#countText(stableSerialize(descriptor)) + TOOL_TOKEN_OVERHEAD;
  }
}

export {
  estimateTokensByCharacters,
  TokenEstimator,
};
