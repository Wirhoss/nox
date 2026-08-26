import { describe, expect, test } from 'bun:test';

import { ConversationParticipants } from './conversation';
import { principal, SYSTEM_CRON } from './principal';

describe('ConversationParticipants', () => {
  test('system speech never turns a single-user conversation into a shared one', () => {
    const participants = new ConversationParticipants([principal('web', 'owner')]);

    participants.observe(SYSTEM_CRON);

    expect(participants.isShared).toBe(false);
  });

  test('still becomes shared when a second human principal speaks', () => {
    const participants = new ConversationParticipants([SYSTEM_CRON, principal('web', 'alice')]);

    participants.observe(principal('web', 'bob'));

    expect(participants.isShared).toBe(true);
  });
});
