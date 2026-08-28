import { brokerConfigSchema } from '@nox/extension-api';
import { describe, expect, test } from 'bun:test';

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
        locked: { grants: {} },
        public: {},
      },
      grants: { 'base-user': ['nox.history.*'] },
      type: 'discord',
    });

    // Stated grants replace the base route's rather than adding to them, so a
    // conversation can be a narrower boundary than the broker it belongs to.
    expect(parsed.conversations.admin).toEqual({
      agent: 'admin',
      grants: { alice: ['*'] },
    });

    // Absent and empty are different answers, which is the whole reason this is
    // optional rather than defaulted. `{}` is an explicit "nobody here".
    expect(parsed.conversations.locked).toEqual({ grants: {} });

    // Absent states nothing about authority and inherits the base route's, so
    // an override that only redirects the agent does not silently revoke every
    // grant in that conversation — which is what a default of `{}` did.
    expect(parsed.conversations.public).toEqual({});
    expect(parsed.conversations.public?.grants).toBeUndefined();
  });

  test('refuses unknown broker configuration fields', () => {
    const result = brokerConfigSchema.safeParse({
      agent: 'nox',
      unsupported: true,
      type: 'discord',
    });

    expect(result.success).toBeFalse();
  });
});
