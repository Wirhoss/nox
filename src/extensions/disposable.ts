interface Disposable {
  dispose(): Promise<void> | void;
}

/** Write-only resource ownership: what a contribution may add, never inspect. */
interface DisposableRegistry {
  add<T extends Disposable>(disposable: T): T;
}

type DisposeAction = () => Promise<void> | void;

function toDisposable(action: DisposeAction): Disposable {
  let disposal: Promise<void> | undefined;

  return {
    dispose(): Promise<void> {
      disposal ??= Promise.resolve().then(action);
      return disposal;
    },
  };
}

/** Owns resources and disposes them once, in reverse registration order. */
class DisposableStore implements Disposable {
  readonly #disposables: Disposable[] = [];

  #disposal: Promise<void> | undefined;

  public get disposed(): boolean {
    return this.#disposal !== undefined;
  }

  public add<T extends Disposable>(disposable: T): T {
    if (this.disposed) {
      throw new Error('Cannot add a resource to a disposed store.');
    }
    this.#disposables.push(disposable);
    return disposable;
  }

  public dispose(): Promise<void> {
    this.#disposal ??= this.#disposeAll();
    return this.#disposal;
  }

  async #disposeAll(): Promise<void> {
    const errors: unknown[] = [];

    // Reverse order: a resource may depend on one registered before it.
    for (const disposable of this.#disposables.reverse()) {
      try {
        await disposable.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#disposables.length = 0;

    if (errors.length > 0) {
      throw new AggregateError(errors, 'One or more resources failed to dispose.');
    }
  }
}

export { DisposableStore, toDisposable };

export type { Disposable, DisposableRegistry, DisposeAction };
