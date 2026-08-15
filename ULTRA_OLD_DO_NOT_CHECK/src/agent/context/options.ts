import {
  assertNonNegativeInteger,
  assertPositiveInteger,
  assertRatio,
} from './validate';

import type { Message } from '../../provider';
import type { Tool } from '../../tool';

const DEFAULT_COMPACT_GUARD_BEGINNING = 5;
const DEFAULT_COMPACT_GUARD_END = 5;
const DEFAULT_COMPACT_MIN_MESSAGES = 10;
const DEFAULT_COMPACT_AT_RATIO = 0.8;
const DEFAULT_MAX_RESERVE_FOR_OUTPUT = 4096;
const DEFAULT_RESERVE_RATIO = 0.2;

interface ContextOptions {
  fullHistory?: readonly Message[];
  tools?: Readonly<Record<string, Tool>>;

  compactGuardBeginning?: number;
  compactGuardEnd?: number;
  compactMinMessages?: number;

  contextWindow?: number;
  reserveForOutput?: number;
  compactAtRatio?: number;
  maxMessageTokens?: number;
  tokenCounter?: (text: string) => number;
}

interface ResolvedContextOptions {
  compactGuardBeginning: number;
  compactGuardEnd: number;
  compactMinMessages: number;
  fullHistory: readonly Message[];
  maxMessageTokens?: number;

  pressureTokenLimit?: number;
  tokenCounter?: (text: string) => number;
  tools: Readonly<Record<string, Tool>>;
}

function resolvePressureTokenLimit(options: ContextOptions): number | undefined {
  if (options.contextWindow === undefined) {
    if (options.reserveForOutput !== undefined || options.compactAtRatio !== undefined) {
      throw new Error('contextWindow is required when configuring context pressure.');
    }
    return undefined;
  }

  assertPositiveInteger(options.contextWindow, 'contextWindow');

  const reserveForOutput = options.reserveForOutput ?? Math.min(
    DEFAULT_MAX_RESERVE_FOR_OUTPUT,
    Math.floor(options.contextWindow * DEFAULT_RESERVE_RATIO),
  );
  assertNonNegativeInteger(reserveForOutput, 'reserveForOutput');
  if (reserveForOutput >= options.contextWindow) {
    throw new RangeError('reserveForOutput must be smaller than contextWindow.');
  }

  const compactAtRatio = options.compactAtRatio ?? DEFAULT_COMPACT_AT_RATIO;
  assertRatio(compactAtRatio, 'compactAtRatio');

  return Math.max(1, Math.floor((options.contextWindow - reserveForOutput) * compactAtRatio));
}

function resolveTools(tools: Readonly<Record<string, Tool>> = {}): Readonly<Record<string, Tool>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(tools)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, tool]) => [name, Object.freeze({ ...tool }) as Tool]),
  ));
}

function resolveContextOptions(options: ContextOptions): ResolvedContextOptions {
  const compactGuardBeginning = options.compactGuardBeginning ?? DEFAULT_COMPACT_GUARD_BEGINNING;
  const compactGuardEnd = options.compactGuardEnd ?? DEFAULT_COMPACT_GUARD_END;
  const compactMinMessages = options.compactMinMessages ?? DEFAULT_COMPACT_MIN_MESSAGES;

  assertNonNegativeInteger(compactGuardBeginning, 'compactGuardBeginning');
  assertNonNegativeInteger(compactGuardEnd, 'compactGuardEnd');
  assertPositiveInteger(compactMinMessages, 'compactMinMessages');
  if (options.maxMessageTokens !== undefined) {
    assertPositiveInteger(options.maxMessageTokens, 'maxMessageTokens');
  }

  return {
    compactGuardBeginning,
    compactGuardEnd,
    compactMinMessages,
    fullHistory: options.fullHistory ?? [],
    maxMessageTokens: options.maxMessageTokens,
    pressureTokenLimit: resolvePressureTokenLimit(options),
    tokenCounter: options.tokenCounter,
    tools: resolveTools(options.tools),
  };
}

export {
  resolveContextOptions,
};

export type {
  ContextOptions,
  ResolvedContextOptions,
};
