class EventLog<T> {
  private events: T[] = [];
  private waiters = new Set<() => void>();
  private closed = false;

  public push(event: T): void {
    if (this.closed) {
      throw new Error('Cannot push to a closed event log.');
    }
    this.events.push(event);
    for (const waiter of this.waiters) {
      waiter();
    }
    this.waiters.clear();
  }

  public close(): void {
    this.closed = true;
    for (const waiter of this.waiters) {
      waiter();
    }
    this.waiters.clear();
  }

  public async *subscribe(from = 0): AsyncGenerator<T> {
    let cursor = from;
    while (true) {
      while (cursor < this.events.length) {
        yield this.events[cursor++]!;
      }
      if (this.closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiters.add(resolve);
      });
    }
  }

  public get length(): number {
    return this.events.length;
  }

  public snapshot(): readonly T[] {
    return this.events;
  }
}

export { EventLog };