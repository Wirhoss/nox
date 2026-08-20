import { describe, expect, test } from 'bun:test';

import { DisposableStore, toDisposable } from './disposable';

describe('toDisposable', () => {
  test('runs the action once no matter how often it is disposed', async () => {
    let disposals = 0;
    const disposable = toDisposable(() => {
      disposals += 1;
    });

    await Promise.all([disposable.dispose(), disposable.dispose()]);
    await disposable.dispose();

    expect(disposals).toBe(1);
  });
});

describe('DisposableStore', () => {
  test('disposes in reverse registration order', async () => {
    const store = new DisposableStore();
    const order: string[] = [];

    for (const name of ['first', 'second', 'third']) {
      store.add(
        toDisposable(() => {
          order.push(name);
        }),
      );
    }
    await store.dispose();

    expect(order).toEqual(['third', 'second', 'first']);
  });

  test('disposes every resource even when one throws, then reports them', async () => {
    const store = new DisposableStore();
    const disposed: string[] = [];

    store.add(
      toDisposable(() => {
        disposed.push('kept');
      }),
    );
    store.add(
      toDisposable(() => {
        throw new Error('teardown failed');
      }),
    );

    const failure: unknown = await store.dispose().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(disposed).toEqual(['kept']);
    expect(store.disposed).toBe(true);
  });

  test('refuses new resources once disposed', async () => {
    const store = new DisposableStore();
    await store.dispose();

    expect(() => store.add(toDisposable(() => undefined))).toThrow(
      'Cannot add a resource to a disposed store.',
    );
  });
});
