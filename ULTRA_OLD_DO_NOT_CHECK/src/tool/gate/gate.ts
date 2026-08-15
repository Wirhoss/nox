import { createLogger } from '../../logger';

import { GateChain } from './chain';
import { EscalationHub } from './escalation';
import { SessionMemoEvaluator } from './evaluators/memo';
import { ReviewerEvaluator } from './evaluators/reviewer';
import { RuleEvaluator } from './evaluators/rules';

import type { ChatProvider } from '../../provider';
import type { GateConfig, GateRule } from './config';
import type { EscalationOutcome } from './escalation';
import type { GateDecision, GateEvaluator, GateRequest } from './types';

const logger = createLogger('gate');

interface ToolGateOptions {
  config: GateConfig;
  declaredRules?: readonly GateRule[];
  reviewProvider?: ChatProvider;
}

class ToolGate {
  public readonly escalation = new EscalationHub();

  readonly #chain: GateChain;
  readonly #memo = new SessionMemoEvaluator();
  readonly #escalationTimeoutMs: number;

  constructor(options: ToolGateOptions) {
    const { config, declaredRules = [], reviewProvider } = options;
    this.#escalationTimeoutMs = config.escalationTimeoutMs;

    const evaluators: GateEvaluator[] = [
      this.#memo,
      new RuleEvaluator([...declaredRules, ...config.rules]),
    ];

    if (config.reviewer.enabled) {
      if (!reviewProvider) {
        throw new Error(
          `Gate reviewer is enabled but provider "${config.reviewer.providerId}" is unavailable.`,
        );
      }
      evaluators.push(new ReviewerEvaluator(config.reviewer, reviewProvider));
    }

    this.#chain = new GateChain(evaluators);

    logger.info(
      {
        evaluators: this.#chain.evaluatorIds,
        ruleCount: declaredRules.length + config.rules.length,
      },
      'Tool gate ready.',
    );
  }

  public get evaluatorIds(): string[] {
    return this.#chain.evaluatorIds;
  }

  public evaluate(request: GateRequest): Promise<GateDecision> {
    return this.#chain.evaluate(request);
  }

  public async escalate(
    request: GateRequest,
    requestId: string,
    reason: string,
  ): Promise<EscalationOutcome> {
    const { entry, execution } = request;
    const outcome = await this.escalation.wait(
      requestId,
      this.#escalationTimeoutMs,
      {
        params: request.params,
        preview: execution.preview,
        reason,
        title: execution.title,
        toolName: entry.tool.name,
        toolSetId: entry.toolSetId,
      },
      request.abortSignal,
    );

    if (outcome.resolution === 'approved' && outcome.scope === 'session') {
      this.#memo.remember(request);
    }
    return outcome;
  }

  public forget(sessionId: string): void {
    this.#memo.forget(sessionId);
  }
}

export {
  ToolGate,
};

export type {
  ToolGateOptions,
};
