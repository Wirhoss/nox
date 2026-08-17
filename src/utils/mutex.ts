/**
 * Serializes tasks against a shared promise tail, so callers that must not
 * interleave run one after another in submission order.
 */
class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  public get idle(): Promise<void> {
    return this.#tail.then(
      () => undefined,
      () => undefined,
    );
  }

  public async run<T>(task: () => Promise<T> | T): Promise<T> {
    const previous = this.#tail;
    const current = previous.then(
      async () => task(),
      async () => task(),
    );

    this.#tail = current.catch(() => undefined);
    return current;
  }
}

export { Mutex };
