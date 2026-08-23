import { z } from 'zod';

import { localeSchema } from '../../i18n/locale';
import { parseOrThrow } from '../../utils/validate';
import { createContributionPoint } from '../contribution';
import { identifierSchema } from '../identifier';

const messageKeySchema = z
  .string()
  .trim()
  .regex(
    /^[a-z][A-Za-z0-9_-]*(?:\.[a-z][A-Za-z0-9_-]*)*$/u,
    'Expected a dot-separated message key.',
  );

const messagesSchema = z.record(messageKeySchema, z.string());

const languagePackSchema = z.strictObject({
  default: z.boolean().optional(),
  direction: z.enum(['ltr', 'rtl']),
  locale: localeSchema,
  messages: messagesSchema,
  /** The language name written in that language, e.g. "English" or "Español". */
  name: z.string().trim().min(1).max(100),
});

const translationFragmentSchema = z.strictObject({
  locale: localeSchema,
  messages: messagesSchema,
  /** Message keys are mounted below this extension-owned namespace. */
  namespace: identifierSchema,
});

type LanguagePackInput = z.input<typeof languagePackSchema>;
type TranslationFragmentInput = z.input<typeof translationFragmentSchema>;
type LanguagePack = Readonly<z.output<typeof languagePackSchema>>;
type TranslationFragment = Readonly<z.output<typeof translationFragmentSchema>>;

function freezeMessages(
  messages: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(Object.entries(messages)));
}

/** Validates a complete language at its extension declaration site. */
function defineLanguagePack(input: LanguagePackInput): LanguagePack {
  const pack = parseOrThrow(languagePackSchema, input);
  return Object.freeze({ ...pack, messages: freezeMessages(pack.messages) });
}

/**
 * Adds extension-specific copy without making a core language package know the
 * feature exists. The feature contributes every locale it supports; the API
 * enforces that only the extension owning a namespace may translate it.
 */
function defineTranslationFragment(input: TranslationFragmentInput): TranslationFragment {
  const fragment = parseOrThrow(translationFragmentSchema, input);
  return Object.freeze({ ...fragment, messages: freezeMessages(fragment.messages) });
}

const languagePacks = createContributionPoint<LanguagePack>('nox.languages');
const translationFragments = createContributionPoint<TranslationFragment>('nox.translations');

export {
  defineLanguagePack,
  defineTranslationFragment,
  languagePacks,
  languagePackSchema,
  localeSchema,
  translationFragments,
  translationFragmentSchema,
};

export type { LanguagePack, LanguagePackInput, TranslationFragment, TranslationFragmentInput };
