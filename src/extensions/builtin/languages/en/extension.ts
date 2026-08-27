import { defineExtension, defineLanguagePack, languagePacks } from '@nox/extension-api';

import { messages } from './messages';

/** The default UI language. Other languages are ordinary extensions beside it. */
const englishLanguageExtension = defineExtension({
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

export default englishLanguageExtension;
export { englishLanguageExtension };
