type EscalationResolution = 'aborted' | 'approved' | 'denied' | 'timeout';

interface EscalationDetail {
  toolName: string;
  toolSetId: string;
  title: string;
  preview?: string;
  params: unknown;
  reason: string;
}

interface PendingEscalation extends EscalationDetail {
  requestId: string;
  requestedAt: number;
  expiresAt: number;
}

interface EscalationOutcome {
  resolution: EscalationResolution;
  scope: 'once' | 'session';
}

interface PendingEntry {
  finish: (outcome: EscalationOutcome) => void;
  info: PendingEscalation;
}

class EscalationHub {
  readonly #pending = new Map<string, PendingEntry>();

  public wait(
    requestId: string,
    timeoutMs: number,
    detail: EscalationDetail,
    signal?: AbortSignal,
  ): Promise<EscalationOutcome> {
    return new Promise((resolve) => {
      const finish = (outcome: EscalationOutcome): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.#pending.delete(requestId);
        resolve(outcome);
      };
      const timer = setTimeout(() => finish({ resolution: 'timeout', scope: 'once' }), timeoutMs);
      const onAbort = (): void => finish({ resolution: 'aborted', scope: 'once' });

      if (signal?.aborted) {
        finish({ resolution: 'aborted', scope: 'once' });
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      const requestedAt = Date.now();
      this.#pending.set(requestId, {
        finish,
        info: { ...detail, expiresAt: requestedAt + timeoutMs, requestedAt, requestId },
      });
    });
  }

  public resolve(
    requestId: string,
    approved: boolean,
    scope: 'once' | 'session' = 'once',
  ): boolean {
    const entry = this.#pending.get(requestId);
    if (!entry) {
      return false;
    }
    entry.finish({
      resolution: approved ? 'approved' : 'denied',
      scope: approved ? scope : 'once',
    });
    return true;
  }

  public has(requestId: string): boolean {
    return this.#pending.has(requestId);
  }

  public listPending(): PendingEscalation[] {
    return [...this.#pending.values()].map((entry) => entry.info);
  }
}

export {
  EscalationHub,
};

export type {
  EscalationDetail,
  EscalationOutcome,
  EscalationResolution,
  PendingEscalation,
};
