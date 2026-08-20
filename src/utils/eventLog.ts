/**
 * An append-only log with cursors: subscribers replay from any point and then
 * follow along live. One log per session backs every observer, so a UI that
 * attaches late sees the whole run rather than whatever happened after it
 * connected.
 */
class EventLog<T> {
  readonly #events: T[] = [];
  readonly #onPush?: (event: T, cursor: number) => void;
  readonly #waiters = new Set<() => void>();

  #closed = false;

  constructor(onPush?: (event: T, cursor: number) => void) {
    this.#onPush = onPush;
  }

  public get isClosed(): boolean {
    return this.#closed;
  }

  public get length(): number {
    return this.#events.length;
  }

  /** Ends every live subscription; replay of what was already logged still works. */
  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#wake();
  }

  public push(event: T): void {
    if (this.#closed) {
      throw new Error('Cannot push to a closed event log.');
    }
    const cursor = this.#events.length;
    this.#events.push(event);
    this.#onPush?.(event, cursor);
    this.#wake();
  }

  public snapshot(): readonly T[] {
    return Object.freeze([...this.#events]);
  }

  /**
   * Yields everything from `from` onwards, then waits for more until the log
   * closes. Events pushed while a consumer is suspended are not missed: the
   * cursor is what decides, not the timing.
   */
  public async *subscribe(from = 0): AsyncGenerator<T> {
    let cursor = Math.max(0, from);

    for (;;) {
      if (cursor < this.#events.length) {
        // Sliced rather than indexed so a `T` that includes undefined still
        // yields, and so the batch is stable while the consumer is suspended.
        const pending = this.#events.slice(cursor);
        cursor += pending.length;
        yield* pending;
        continue;
      }

      if (this.#closed) return;

      await new Promise<void>((resolve) => {
        this.#waiters.add(resolve);
      });
    }
  }

  #wake(): void {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const waiter of waiters) waiter();
  }
}

export { EventLog };
