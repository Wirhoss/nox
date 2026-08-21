import { describe, expect, test } from 'bun:test';

import { brokerConfigSchema } from './brokers';

describe('broker configuration', () => {
  test('defaults to granting nobody anything', () => {
    const parsed = brokerConfigSchema.parse({ agent: 'nox', type: 'discord' });

    // Ingress filtering belongs to the concrete transport. Nobody can make the
    // agent act until a base route or explicit conversation override grants it.
    expect(parsed.conversations).toEqual({});
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

  test('materializes conversation overrides as replacement security boundaries', () => {
    const parsed = brokerConfigSchema.parse({
      agent: 'reader',
      conversations: {
        admin: {
          agent: 'admin',
          grants: { alice: ['*'] },
        },
        public: {},
      },
      grants: { 'base-user': ['nox.history.*'] },
      type: 'discord',
    });

    expect(parsed.conversations.admin).toEqual({
      agent: 'admin',
      grants: { alice: ['*'] },
    });
    // Missing override values do not inherit privileged base access.
    expect(parsed.conversations.public).toEqual({ grants: {} });
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
