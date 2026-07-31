import { createLogger } from '../../logger';

import type { GateDecision, GateEvaluator, GateRequest } from './types';

const logger = createLogger('gate');

const DEFAULT_DECISION = 'default';

class GateChain {
  readonly #evaluators: readonly GateEvaluator[];

  constructor(evaluators: readonly GateEvaluator[]) {
    this.#evaluators = [...evaluators];
  }

  public get evaluatorIds(): string[] {
    return this.#evaluators.map((evaluator) => evaluator.id);
  }

  public async evaluate(request: GateRequest): Promise<GateDecision> {
    for (const evaluator of this.#evaluators) {
      const verdict = await evaluator.evaluate(request);
      if (verdict.verdict === 'abstain') continue;

      if (verdict.verdict !== 'allow') {
        logger.info(
          {
            evaluatorId: evaluator.id,
            reason: verdict.reason,
            sessionId: request.sessionId,
            toolName: request.entry.tool.name,
            verdict: verdict.verdict,
          },
          'Gate decision.',
        );
      }
      return { ...verdict, evaluatorId: evaluator.id };
    }

    return {
      evaluatorId: DEFAULT_DECISION,
      reason: 'No gate rule matched.',
      verdict: 'allow',
    };
  }
}

export {
  GateChain,
};
