type EscalationResolution = 'approved' | 'denied' | 'timeout' | 'aborted';

interface EscalationDetail {
  toolName: string;
  toolArguments: Record<string, unknown>;
  reason: string;
}

interface PendingEscalation extends EscalationDetail {
  requestId: string;
  requestedAt: number;
  expiresAt: number;
}

interface PendingEntry {
  finish: (resolution: EscalationResolution) => void;
  info: PendingEscalation;
}

class EscalationHub {
  private readonly pending = new Map<string, PendingEntry>();

  public wait(requestId: string, timeoutMs: number, signal?: AbortSignal, detail?: EscalationDetail): Promise<EscalationResolution> {
    return new Promise((resolve) => {
      const finish = (resolution: EscalationResolution) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(requestId);
        resolve(resolution);
      };
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      const onAbort = () => finish('aborted');

      if (signal?.aborted) {
        finish('aborted');
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      const requestedAt = Date.now();
      this.pending.set(requestId, {
        finish,
        info: {
          requestId,
          toolName: detail?.toolName ?? 'unknown',
          toolArguments: detail?.toolArguments ?? {},
          reason: detail?.reason ?? '',
          requestedAt,
          expiresAt: requestedAt + timeoutMs,
        },
      });
    });
  }

  public resolve(requestId: string, approved: boolean): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) {
      return false;
    }
    entry.finish(approved ? 'approved' : 'denied');
    return true;
  }

  public has(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  public listPending(): PendingEscalation[] {
    return [...this.pending.values()].map((entry) => entry.info);
  }
}

export {
  EscalationHub,
};

export type {
  EscalationResolution,
  PendingEscalation,
};
