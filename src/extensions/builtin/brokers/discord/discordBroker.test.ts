import { describe, expect, test } from 'bun:test';

import { staleCommandScopes } from './discordBroker';

describe('Discord command publication scopes', () => {
  test('global publication clears every guild catalog Discord reported', () => {
    expect(staleCommandScopes(undefined, ['guild-1', 'guild-2', 'guild-1'])).toEqual([
      'guild-1',
      'guild-2',
    ]);
  });

  test('guild publication clears global and every other guild catalog', () => {
    expect(staleCommandScopes('guild-1', ['guild-1', 'guild-2'])).toEqual([undefined, 'guild-2']);
  });
});
