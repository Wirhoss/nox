import type { Message } from '../../provider';
import type { Tool } from '../../tool';


interface SessionSearchOptions {
  limit?: number;
  sizeLimit?: number;
  avoidInCurrentHistory?: boolean;
}

export type {
  ContextOptions,
  SessionSearchOptions,
};
