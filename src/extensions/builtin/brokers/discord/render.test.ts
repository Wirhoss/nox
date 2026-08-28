import { describe, expect, test } from 'bun:test';

import { chunkMessage, MESSAGE_LIMIT } from './render';

describe('chunkMessage', () => {
  test('leaves a reply that already fits as one message', () => {
    expect(chunkMessage('  hello  ')).toEqual(['hello']);
    expect(chunkMessage('   ')).toEqual([]);
  });

  test('never exceeds what Discord accepts', () => {
    const long = Array.from({ length: 400 }, (_, index) => `line ${String(index)}`).join('\n');

    for (const chunk of chunkMessage(long)) {
      expect(chunk.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
    }
  });

  test('splits on line boundaries and loses nothing', () => {
    const lines = Array.from({ length: 300 }, (_, index) => `line ${String(index)}`);
    const chunks = chunkMessage(lines.join('\n'));

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('\n').split('\n')).toEqual(lines);
  });

  test('closes and reopens a code fence that spans a split', () => {
    const body = Array.from({ length: 120 }, (_, index) => `  const x${String(index)} = 1;`);
    const chunks = chunkMessage(['```ts', ...body, '```'].join('\n'), 400);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const fences = chunk.split('\n').filter((line) => line.startsWith('```')).length;
      expect(fences % 2).toBe(0);
    }
    expect(chunks[1]?.startsWith('```ts')).toBeTrue();
  });

  test('cuts a single unbroken line rather than exceeding the limit', () => {
    const chunks = chunkMessage('x'.repeat(5000), 200);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 200)).toBeTrue();
    expect(chunks.join('').length).toBe(5000);
  });
});
