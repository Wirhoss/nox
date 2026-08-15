import { callKey } from '../key';

import type { GateEvaluator, GateRequest, GateVerdict } from '../types';

class SessionMemoEvaluator implements GateEvaluator {
  public readonly id = 'memo';

  readonly #approved = new Map<string, Set<string>>();

  public evaluate(request: GateRequest): GateVerdict {
    const keys = this.#approved.get(request.sessionId);
    if (keys?.has(callKey(request.entry.tool.name, request.params)) !== true) {
      return { verdict: 'abstain' };
    }
    return { reason: 'Approved earlier in this session.', verdict: 'allow' };
  }

  public remember(request: GateRequest): void {
    const keys = this.#approved.get(request.sessionId) ?? new Set<string>();
    keys.add(callKey(request.entry.tool.name, request.params));
    this.#approved.set(request.sessionId, keys);
  }

  public forget(sessionId: string): void {
    this.#approved.delete(sessionId);
  }
}

export {
  SessionMemoEvaluator,
};
