import type { Message } from '../../provider';
import type { Tool } from '../../tool';

interface ContextOptions {
  fullHistory?: Message[];
  tools?: Record<string, Tool>;

  compactGuardBeginning?: number;
  compactGuardEnd?: number;
  compactMinMessages?: number;
}

interface SessionSearchOptions {
  limit?: number;
  sizeLimit?: number;
  avoidInCurrentHistory?: boolean;
}

export type {
  ContextOptions,
  SessionSearchOptions,
};
