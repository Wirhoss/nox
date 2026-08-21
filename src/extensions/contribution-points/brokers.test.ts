import { describe, expect, test } from 'bun:test';

import { brokerConfigSchema } from './brokers';

describe('broker configuration', () => {
  test('defaults to granting nobody anything', () => {
    const parsed = brokerConfigSchema.parse({ agent: 'nox', type: 'discord' });

    // Everyone in the conversation can still talk to the agent. Nobody can make
    // it act until this names them.
    expect(parsed.grants).toEqual({});
  });

  test('keeps grants per sender, since the issuer is this broker', () => {
    const parsed = brokerConfigSchema.parse({
      agent: 'nox',
      grants: { '1234567890': ['nox.history.*'] },
      type: 'discord',
    });

    expect(parsed.grants).toEqual({ '1234567890': ['nox.history.*'] });
  });

  test('refuses to load a configuration that still names approvers', () => {
    const result = brokerConfigSchema.safeParse({
      agent: 'nox',
      approvers: ['boss'],
      type: 'discord',
    });

    // Dropping the key silently would quietly change who can approve what.
    expect(result.success).toBeFalse();
    expect(result.error?.issues[0]?.message).toContain('"approvers" was removed');
  });
});
