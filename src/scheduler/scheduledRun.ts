import { raceWithAbort } from '../utils/abort';

import type {
  Disposable,
  ScheduledRunDelivery,
  ScheduledRunHost,
  ScheduledRunRequest,
  ScheduledRunResult,
} from '@nox/extension-api';

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

  public async canDeliverTo(delivery: ScheduledRunDelivery, signal: AbortSignal): Promise<boolean> {
    const host = await this.#hostFor(signal);
    return raceWithAbort(signal, () => host.canDeliverTo(delivery, signal));
  }

  public async deliveryBrokerIds(signal: AbortSignal): Promise<readonly string[]> {
    const host = await this.#hostFor(signal);
    return raceWithAbort(signal, () => host.deliveryBrokerIds(signal));
  }

  public async deliveryOrigin(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<ScheduledRunDelivery | undefined> {
    const host = await this.#hostFor(signal);
    return raceWithAbort(signal, () => host.deliveryOrigin(sessionId, signal));
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
