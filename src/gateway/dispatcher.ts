import type { AgentStreamEvent } from '../agent/runner';
import type { PendingEscalation } from '../gate';
import type { Message } from '../provider';

interface GatewaySession {
  readonly eventCursor: number;
  readonly history: readonly Message[];
  readonly idle: Promise<void>;
  readonly isRunning: boolean;
  abort(): Promise<boolean>;
  listPendingPermissions(): PendingEscalation[];
  resolvePermission(requestId: string, approved: boolean): boolean;
  run(message: string): Promise<unknown>;
  steer(message: string): Promise<unknown>;
  subscribeToEvents(from?: number): AsyncGenerator<AgentStreamEvent>;
}

const DEFAULT_DEBOUNCE_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SessionDispatcher {
  private readonly session: GatewaySession;
  private readonly debounceMs: number;
  private readonly onError: (error: Error) => void;

  private pending: string[] = [];
  private draining = false;

  constructor(session: GatewaySession, onError: (error: Error) => void, debounceMs = DEFAULT_DEBOUNCE_MS) {
    this.session = session;
    this.onError = onError;
    this.debounceMs = debounceMs;
  }

  public submit(text: string, steer = false): 'queued' | 'steered' {
    if (steer && this.session.isRunning) {
      this.session.steer(text).catch((error) => this.onError(toError(error)));
      return 'steered';
    }
    this.pending.push(text);
    void this.drain();
    return 'queued';
  }

  public clearPending(): void {
    this.pending = [];
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        await sleep(this.debounceMs);
        if (this.session.isRunning) {
          await this.session.idle;
          continue;
        }
        const batch = this.pending.splice(0);
        if (batch.length === 0) {
          continue;
        }
        const text = batch.join('\n');
        try {
          await this.session.run(text);
        } catch (error) {
          this.onError(toError(error));
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export {
  DEFAULT_DEBOUNCE_MS,
  SessionDispatcher,
};

export type {
  GatewaySession,
};
