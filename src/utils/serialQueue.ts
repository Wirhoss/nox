class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();

  public run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task, task);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  public async drain(): Promise<void> {
    await this.#tail;
  }
}

export {
  SerialQueue,
};
