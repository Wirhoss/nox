import { describe, expect, test } from 'bun:test';

import { defineLanguagePack, defineTranslationFragment } from './languages';

describe('language contributions', () => {
  test('normalizes locale tags and freezes catalogs at the declaration site', () => {
    const source = { 'common.save': 'Save' };
    const pack = defineLanguagePack({
      direction: 'ltr',
      locale: 'EN',
      messages: source,
      name: 'English',
    });
    source['common.save'] = 'Changed later';

    expect(pack.locale).toBe('en');
    expect(pack.messages['common.save']).toBe('Save');
    expect(Object.isFrozen(pack)).toBe(true);
    expect(Object.isFrozen(pack.messages)).toBe(true);
  });

  test('rejects malformed locales, namespaces and message keys', () => {
    expect(() =>
      defineLanguagePack({
        direction: 'ltr',
        locale: '../en',
        messages: {},
        name: 'English',
      }),
    ).toThrow();
    expect(() =>
      defineTranslationFragment({
        locale: 'en',
        messages: { 'Not a key': 'No' },
        namespace: 'test.feature',
      }),
    ).toThrow();
    expect(() =>
      defineTranslationFragment({
        locale: 'en',
        messages: {},
        namespace: 'Not A Package',
      }),
    ).toThrow();
  });
});
