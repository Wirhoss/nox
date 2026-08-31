import { describe, expect, test } from 'bun:test';

import { testOrigin } from '../../testFixtures';
import { messageToString, originToString } from './message';

import type { UserMessage } from '@nox/extension-api';

function userMessage(displayName?: string): UserMessage {
  const origin = testOrigin('409812000000000000');
  return {
    content: [{ text: 'hola', type: 'text' }],
    createdAt: new Date('2026-08-28T14:03:11.000Z'),
    delivery: 'message',
    messageId: 'message-1',
    origin: displayName === undefined ? origin : { ...origin, displayName },
    role: 'user',
  };
}

describe('originToString', () => {
  test('names the principal alone when the transport had no name for it', () => {
    expect(originToString(testOrigin('409812000000000000'))).toBe('test-broker:409812000000000000');
  });

  test('puts the display name in front without dropping the principal', () => {
    // The name is what makes a shared transcript one the model can talk about;
    // the principal is what anything was actually decided from, so both stay.
    expect(originToString({ ...testOrigin('409812000000000000'), displayName: 'Wirhoss' })).toBe(
      'Wirhoss <test-broker:409812000000000000>',
    );
  });

  test('keeps two people apart when they chose the same name', () => {
    const first = { ...testOrigin('111111111111111111'), displayName: 'nox' };
    const second = { ...testOrigin('222222222222222222'), displayName: 'nox' };

    expect(originToString(first)).not.toBe(originToString(second));
  });
});

describe('messageToString', () => {
  test('renders a named sender on the From line', () => {
    expect(messageToString(userMessage('Wirhoss'))).toContain(
      'From: Wirhoss <test-broker:409812000000000000>',
    );
  });

  test('falls back to what every surface showed before', () => {
    expect(messageToString(userMessage())).toContain('From: test-broker:409812000000000000');
  });

  test('still carries when it was said, not when Nox read it', () => {
    expect(messageToString(userMessage('Wirhoss'))).toContain(
      'Created At: 2026-08-28T14:03:11.000Z',
    );
  });
});
