import { defineLanguagePack, languagePacks } from '../../../contribution-points/languages';
import { defineExtension } from '../../../extension';
import { messages } from './messages';

/** The default UI language. Other languages are ordinary extensions beside it. */
const englishLanguageExtension = defineExtension({
  manifest: { engines: { nox: '^0.1.0' }, id: 'nox.language.en' },
  activate(context) {
    context.contributions.register(
      languagePacks,
      'en',
      defineLanguagePack({
        default: true,
        direction: 'ltr',
        locale: 'en',
        messages,
        name: 'English',
      }),
    );
  },
});

export { englishLanguageExtension };
