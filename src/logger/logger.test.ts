import { describe, expect, test } from 'bun:test';

import { createLogger } from './logger';

describe('ConsoleLogger runtime level', () => {
  test('updates the root and every existing child through shared state', () => {
    const lines: string[] = [];
    const root = createLogger('nox', { level: 'warn', write: (line) => lines.push(line) });
    const child = root.child('gateway');

    child.info({}, 'hidden');
    root.setLevel?.('trace');
    child.trace({}, 'visible from child');
    child.setLevel?.('error');
    root.warn({}, 'hidden again');
    root.error({}, 'visible from root');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('TRC nox:gateway visible from child');
    expect(lines[1]).toContain('ERR nox visible from root');
  });
});
