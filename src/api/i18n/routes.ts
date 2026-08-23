import { Elysia } from 'elysia';

import {
  type LanguagePack,
  languagePacks,
  translationFragments,
} from '../../extensions/contribution-points/languages';

import type { ContributionReader } from '../../extensions/contribution';

interface LanguageRoutesOptions {
  readonly configuredLocale?: string;
  readonly contributions: ContributionReader;
}

interface LanguageDescriptor {
  readonly direction: LanguagePack['direction'];
  readonly locale: string;
  readonly name: string;
}

interface LanguageCatalog {
  readonly configuredLocale?: string;
  readonly defaultLocale: string;
  readonly languages: readonly LanguageDescriptor[];
}

const NO_LANGUAGE = { error: 'language_not_found' } as const;

function availablePacks(contributions: ContributionReader): readonly LanguagePack[] {
  const byLocale = new Map<string, LanguagePack>();
  for (const contribution of contributions.list(languagePacks)) {
    const { locale } = contribution.value;
    if (contribution.id !== locale) {
      throw new Error(
        `Language contribution "${contribution.id}" declares locale "${locale}"; ` +
          'the contribution ID and locale must be the same.',
      );
    }
    if (byLocale.has(locale))
      throw new Error(`Language "${locale}" was contributed more than once.`);
    byLocale.set(locale, contribution.value);
  }
  return Object.freeze([...byLocale.values()].sort((a, b) => a.locale.localeCompare(b.locale)));
}

function catalog(options: LanguageRoutesOptions): LanguageCatalog {
  const packs = availablePacks(options.contributions);
  const defaults = packs.filter((pack) => pack.default === true);
  if (defaults.length > 1) {
    throw new Error(
      `More than one default language was contributed: ${defaults.map((pack) => pack.locale).join(', ')}.`,
    );
  }
  const fallback = defaults[0] ?? packs[0];
  if (fallback === undefined) throw new Error('No extension contributed a language pack.');

  const configuredLocale = packs.some((pack) => pack.locale === options.configuredLocale)
    ? options.configuredLocale
    : undefined;
  return Object.freeze({
    ...(configuredLocale === undefined ? {} : { configuredLocale }),
    defaultLocale: fallback.locale,
    languages: Object.freeze(
      packs.map((pack) =>
        Object.freeze({ direction: pack.direction, locale: pack.locale, name: pack.name }),
      ),
    ),
  });
}

function resolvedPack(
  contributions: ContributionReader,
  locale: string,
): (LanguageDescriptor & { readonly messages: Readonly<Record<string, string>> }) | undefined {
  const pack = availablePacks(contributions).find((candidate) => candidate.locale === locale);
  if (pack === undefined) return undefined;

  const messages = new Map(Object.entries(pack.messages));
  for (const contribution of contributions.list(translationFragments)) {
    const fragment = contribution.value;
    if (fragment.locale !== locale) continue;
    if (fragment.namespace !== contribution.extensionId) {
      throw new Error(
        `Extension "${contribution.extensionId}" cannot translate namespace "${fragment.namespace}".`,
      );
    }

    for (const [key, message] of Object.entries(fragment.messages)) {
      const namespacedKey = `${fragment.namespace}.${key}`;
      if (messages.has(namespacedKey)) {
        throw new Error(
          `Translation key "${namespacedKey}" for locale "${locale}" was contributed more than once.`,
        );
      }
      messages.set(namespacedKey, message);
    }
  }

  return Object.freeze({
    direction: pack.direction,
    locale: pack.locale,
    messages: Object.freeze(Object.fromEntries(messages)),
    name: pack.name,
  });
}

/** Public because the access screen needs its language before anybody can authenticate. */
function createLanguageRoutes(options: LanguageRoutesOptions) {
  return new Elysia({ name: 'nox.api.i18n.routes' })
    .get('/i18n/languages', () => catalog(options))
    .get('/i18n/languages/:locale', ({ params, status }) => {
      const pack = resolvedPack(options.contributions, params.locale.toLowerCase());
      return pack ?? status(404, NO_LANGUAGE);
    });
}

function languageRoutes(options: LanguageRoutesOptions): ReturnType<typeof createLanguageRoutes> {
  return createLanguageRoutes(options);
}

export { languageRoutes };

export type { LanguageCatalog, LanguageDescriptor, LanguageRoutesOptions };
