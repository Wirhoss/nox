import { defineLanguagePack, languagePacks } from '../../../contribution-points/languages';
import { defineExtension } from '../../../extension';
import { messages } from './messages';

/** Spanish translations for the extension-independent Nox UI. */
const spanishLanguageExtension = defineExtension({
  manifest: { engines: { nox: '^0.1.0' }, id: 'nox.language.es' },
  activate(context) {
    context.contributions.register(
      languagePacks,
      'es',
      defineLanguagePack({
        direction: 'ltr',
        locale: 'es',
        messages,
        name: 'Español',
      }),
    );
  },
});

export { spanishLanguageExtension };
