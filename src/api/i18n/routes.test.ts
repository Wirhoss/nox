import {
  defineExtension,
  defineLanguagePack,
  defineTranslationFragment,
  languagePacks,
  translationFragments,
} from '@nox/extension-api';
import { describe, expect, test } from 'bun:test';

import { NoxApplication } from '../../application';
import { ApiServer } from '../server';

function manifest(id: string) {
  return {
    engines: { extensionApi: '*', nox: '^0.1.0' },
    id,
    main: 'embedded.js',
    schemaVersion: 1 as const,
    version: '0.0.0',
  };
}

const languageExtension = defineExtension({
  manifest: manifest('test.language'),
  activate(context) {
    context.contributions.register(
      languagePacks,
      'en',
      defineLanguagePack({
        default: true,
        direction: 'ltr',
        locale: 'en',
        messages: { 'common.save': 'Save' },
        name: 'English',
      }),
    );
  },
});

const rogueTranslationExtension = defineExtension({
  manifest: manifest('test.rogue'),
  activate(context) {
    context.contributions.register(
      translationFragments,
      'test.rogue.en',
      defineTranslationFragment({
        locale: 'en',
        messages: { label: 'Claimed by another extension' },
        namespace: 'test.feature',
      }),
    );
  },
});

const featureExtension = defineExtension({
  manifest: manifest('test.feature'),
  activate(context) {
    context.contributions.register(
      translationFragments,
      'test.feature.en',
      defineTranslationFragment({
        locale: 'en',
        messages: { 'editor.label': 'Feature label' },
        namespace: 'test.feature',
      }),
    );
  },
});

describe('language API', () => {
  test('serves extension language packs with feature-owned copy merged by namespace', async () => {
    const application = new NoxApplication({ extensions: [languageExtension, featureExtension] });
    await application.start();
    const server = ApiServer.create({
      host: '127.0.0.1',
      languages: application.contributions,
      locale: 'en',
      port: 0,
    });
    await server.listen();

    try {
      const catalog = await fetch(`${server.url}/api/i18n/languages`);
      expect(catalog.status).toBe(200);
      expect(await catalog.json()).toEqual({
        configuredLocale: 'en',
        defaultLocale: 'en',
        languages: [{ direction: 'ltr', locale: 'en', name: 'English' }],
      });

      const pack = await fetch(`${server.url}/api/i18n/languages/en`);
      expect(pack.status).toBe(200);
      expect(await pack.json()).toEqual({
        direction: 'ltr',
        locale: 'en',
        messages: {
          'common.save': 'Save',
          'test.feature.editor.label': 'Feature label',
        },
        name: 'English',
      });

      expect((await fetch(`${server.url}/api/i18n/languages/es`)).status).toBe(404);
    } finally {
      await server.dispose();
      await application.stop();
    }
  });

  test('refuses a fragment that claims another extension namespace', async () => {
    const application = new NoxApplication({
      extensions: [languageExtension, rogueTranslationExtension],
    });
    await application.start();
    const server = ApiServer.create({
      host: '127.0.0.1',
      languages: application.contributions,
      port: 0,
    });
    await server.listen();

    try {
      expect((await fetch(`${server.url}/api/i18n/languages/en`)).status).toBe(500);
    } finally {
      await server.dispose();
      await application.stop();
    }
  });
});
