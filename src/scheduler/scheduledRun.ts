import { raceWithAbort } from '../utils/abort';

import type { MessageContent } from '../agent/context/message';
import type { RunStatus } from '../agent/events';
import type { Disposable } from '../extensions/disposable';

/** Optional output destination. It is a channel sink, never an execution session. */
interface ScheduledRunDelivery {
  readonly brokerId: string;
  readonly channelId: string;
}

/** One fresh configured-agent execution requested by a durable scheduler. */
interface ScheduledRunRequest {
  readonly agentId: string;
  /** Durable scheduler-owned identity used as the run's cause. */
  readonly causeId: string;
  readonly delivery?: ScheduledRunDelivery;
  readonly name: string;
  readonly prompt: string;
  /** Preallocated so the durable run row identifies the session before it starts. */
  readonly sessionId: string;
  /** Cancels execution while the scheduler or application is shutting down. */
  readonly signal: AbortSignal;
}

interface ScheduledRunResult {
  readonly completedAt: Date;
  readonly content: readonly MessageContent[];
  readonly deliveredAt?: Date;
  readonly deliveryError?: string;
  readonly error?: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly startedAt: Date;
  readonly status: RunStatus;
}

/** Host boundary used by schedulers; the runtime is the concrete implementation. */
interface ScheduledRunHost {
  agentIds(signal: AbortSignal): Promise<readonly string[]>;
  deliveryBrokerIds(signal: AbortSignal): Promise<readonly string[]>;
  runScheduledAgent(request: ScheduledRunRequest): Promise<ScheduledRunResult>;
}

/**
 * Lets an extension receive the host before agent and broker composition finishes.
 * Calls during composition wait for the one host rather than racing a partial runtime.
 */
class ScheduledRunRelay implements ScheduledRunHost, Disposable {
  readonly #ready: Promise<ScheduledRunHost>;

  #disposed = false;
  #host?: ScheduledRunHost;
  #resolve!: (host: ScheduledRunHost) => void;

  constructor() {
    this.#ready = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  public connect(host: ScheduledRunHost): void {
    if (this.#disposed) throw new Error('Cannot connect a disposed scheduled-run relay.');
    if (this.#host !== undefined) throw new Error('A scheduled-run host is already connected.');
    this.#host = host;
    this.#resolve(host);
  }

  public dispose(): void {
    this.#disposed = true;
    this.#host = undefined;
  }

  public async agentIds(signal: AbortSignal): Promise<readonly string[]> {
    const host = await this.#hostFor(signal);
    return raceWithAbort(signal, () => host.agentIds(signal));
  }

  public async deliveryBrokerIds(signal: AbortSignal): Promise<readonly string[]> {
    const host = await this.#hostFor(signal);
    return raceWithAbort(signal, () => host.deliveryBrokerIds(signal));
  }

  public async runScheduledAgent(request: ScheduledRunRequest): Promise<ScheduledRunResult> {
    const host = await this.#hostFor(request.signal);
    return raceWithAbort(request.signal, () => host.runScheduledAgent(request));
  }

  async #hostFor(signal: AbortSignal): Promise<ScheduledRunHost> {
    this.#assertActive();
    const host = await raceWithAbort(signal, () => this.#host ?? this.#ready);
    this.#assertActive();
    return host;
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('Scheduled-run host is no longer available.');
  }
}

export { ScheduledRunRelay };

export type { ScheduledRunDelivery, ScheduledRunHost, ScheduledRunRequest, ScheduledRunResult };
