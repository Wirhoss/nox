import { isAbsolute, relative, resolve } from 'node:path';

import type { GatePolicy } from './config';
import type { GateEvaluation, GateEvaluator, GateRequest, RiskSignal } from './types';
import type { ToolEffect, ToolResource } from '@nox/extension-api';

const MUTATING_EFFECTS = new Set<ToolEffect>([
  'authentication',
  'delete',
  'execute',
  'payment',
  'privilege',
  'upload',
  'write',
]);

function isWithin(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate));
  return relation.length === 0 || (!relation.startsWith('..') && !isAbsolute(relation));
}

function domainAllowed(hostname: string, allowed: readonly string[]): boolean {
  const normalized = hostname.toLowerCase();
  return allowed.some((entry) => {
    const domain = entry.toLowerCase().replace(/^\*\./, '');
    return normalized === domain || normalized.endsWith(`.${domain}`);
  });
}

function signal(
  code: string,
  severity: RiskSignal['severity'],
  reason: string,
  resource?: string,
): RiskSignal {
  return { code, reason, resource, severity };
}

function resourcesOf(request: GateRequest, kind: ToolResource['kind']): readonly ToolResource[] {
  return (request.risk?.resources ?? []).filter((resource) => resource.kind === kind);
}

class RiskHeuristicEvaluator implements GateEvaluator {
  public readonly id = 'heuristics';

  readonly #allowedDomains: readonly string[];
  readonly #allowedRoots: readonly string[];
  readonly #enabled: boolean;
  readonly #maxBatchSize: number;
  readonly #sensitivePaths: readonly RegExp[];

  constructor(policy: GatePolicy['heuristics']) {
    this.#allowedDomains = policy.allowedDomains;
    this.#allowedRoots = policy.allowedRoots;
    this.#enabled = policy.enabled;
    this.#maxBatchSize = policy.maxBatchSize;
    this.#sensitivePaths = policy.sensitivePathPatterns.map((source) => new RegExp(source, 'i'));
  }

  public evaluate(request: GateRequest): GateEvaluation {
    if (!this.#enabled || request.risk === undefined) return { verdict: 'abstain' };

    const { effects, resources = [], reversible, volume } = request.risk;
    const signals: RiskSignal[] = [];

    for (const effect of new Set(effects)) {
      switch (effect) {
        case 'authentication':
          signals.push(signal('authentication', 'approval', 'Changes authentication state.'));
          break;
        case 'credential':
          signals.push(signal('credential', 'approval', 'Handles credentials or secret material.'));
          break;
        case 'delete':
          signals.push(signal('delete', 'approval', 'Deletes data.'));
          break;
        case 'execute':
          signals.push(signal('execute', 'review', 'Executes a process or command.'));
          break;
        case 'payment':
          signals.push(signal('payment', 'approval', 'Can transfer or spend money.'));
          break;
        case 'privilege':
          signals.push(signal('privilege', 'approval', 'Changes or uses elevated privileges.'));
          break;
        case 'upload':
          signals.push(
            signal('upload', 'approval', 'Sends local data to an external destination.'),
          );
          break;
        case 'network':
        case 'read':
        case 'write':
          break;
      }
    }

    this.#inspectFiles(request, signals);
    this.#inspectNetwork(request, signals);

    if (volume !== undefined && volume > this.#maxBatchSize) {
      signals.push(
        signal(
          'large_batch',
          'approval',
          `Affects ${String(volume)} items, above the configured limit of ${String(this.#maxBatchSize)}.`,
        ),
      );
    }
    if (reversible === false && effects.some((effect) => MUTATING_EFFECTS.has(effect))) {
      signals.push(signal('irreversible', 'approval', 'The action declares itself irreversible.'));
    }
    if (resources.length === 0 && effects.some((effect) => MUTATING_EFFECTS.has(effect))) {
      signals.push(
        signal(
          'unspecified_resource',
          'review',
          'A consequential action did not identify its target.',
        ),
      );
    }

    const strongest = signals.some(({ severity }) => severity === 'deny')
      ? 'deny'
      : signals.some(({ severity }) => severity === 'approval' || severity === 'review')
        ? 'escalate'
        : undefined;
    if (strongest === undefined) return { signals, verdict: 'abstain' };

    return {
      reason: signals
        .filter(({ severity }) => severity !== 'info')
        .map(({ reason }) => reason)
        .join(' '),
      signals,
      verdict: strongest,
    };
  }

  #inspectFiles(request: GateRequest, signals: RiskSignal[]): void {
    const effects = new Set(request.risk?.effects ?? []);
    for (const { value } of resourcesOf(request, 'file')) {
      if (effects.has('read') && this.#sensitivePaths.some((pattern) => pattern.test(value))) {
        signals.push(signal('sensitive_path', 'approval', 'Reads a sensitive path.', value));
      }
      if (effects.has('write') || effects.has('delete') || effects.has('execute')) {
        if (this.#allowedRoots.length === 0) {
          signals.push(
            signal(
              'unbounded_file_access',
              'review',
              'No allowed filesystem root is configured.',
              value,
            ),
          );
        } else if (!this.#allowedRoots.some((root) => isWithin(root, value))) {
          signals.push(
            signal(
              'outside_allowed_root',
              'approval',
              'Targets a path outside allowed roots.',
              value,
            ),
          );
        }
      }
    }
  }

  #inspectNetwork(request: GateRequest, signals: RiskSignal[]): void {
    const effects = new Set(request.risk?.effects ?? []);
    if (!effects.has('network') && !effects.has('upload')) return;

    const urls = resourcesOf(request, 'url');
    if (urls.length === 0) {
      signals.push(signal('unknown_destination', 'review', 'Network destination is unspecified.'));
      return;
    }

    for (const { value } of urls) {
      let hostname: string;
      try {
        hostname = new URL(value).hostname;
      } catch {
        signals.push(
          signal('invalid_destination', 'approval', 'Network destination is invalid.', value),
        );
        continue;
      }
      if (!domainAllowed(hostname, this.#allowedDomains)) {
        signals.push(
          signal('unknown_domain', 'review', 'Targets a domain outside the allowlist.', hostname),
        );
      }
    }
  }
}

export { RiskHeuristicEvaluator };
