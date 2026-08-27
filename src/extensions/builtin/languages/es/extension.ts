import { defineExtension, defineLanguagePack, languagePacks } from '@nox/extension-api';

import { messages } from './messages';

/** Spanish translations for the extension-independent Nox UI. */
const spanishLanguageExtension = defineExtension({
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

export default spanishLanguageExtension;
export { spanishLanguageExtension };
