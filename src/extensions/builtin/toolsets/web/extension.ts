import { authorities } from '../../../contribution-points/authorities';
import {
  defineTranslationFragment,
  translationFragments,
} from '../../../contribution-points/languages';
import { toolSetContribution, toolSets } from '../../../contribution-points/toolsets';
import { defineExtension } from '../../../extension';
import { englishMessages } from './messages';
import { spanishMessages } from './messages.es';
import { BROWSER_ACT_AUTHORITY, BROWSER_READ_AUTHORITY } from './tools/browser';
import { WEB_EXTRACT_AUTHORITY } from './tools/extract';
import { WEB_SEARCH_AUTHORITY } from './tools/search';
import { WebToolSet } from './webToolSet';

/** Contributes the builtin web tool set: search, extraction and a browser. */
const webToolsExtension = defineExtension({
  manifest: { engines: { nox: '^0.1.0' }, id: 'nox.toolset.web' },
  activate(context) {
    context.contributions.register(
      translationFragments,
      'nox.toolset.web.en',
      defineTranslationFragment({
        locale: 'en',
        messages: englishMessages,
        namespace: 'nox.toolset.web',
      }),
    );

    context.contributions.register(
      translationFragments,
      'nox.toolset.web.es',
      defineTranslationFragment({
        locale: 'es',
        messages: spanishMessages,
        namespace: 'nox.toolset.web',
      }),
    );

    // Declared before the tools that reference them: an authority nobody
    // registered cannot be granted, and a tool naming one cannot be composed.
    // Four rather than one, because searching the public web, downloading what a
    // page is made of, reading a page in a browser, and clicking and typing on
    // one are four different permissions to grant or withhold — an agent can be
    // given a browser it may look at and not touch.
    context.contributions.register(authorities, WEB_SEARCH_AUTHORITY, {
      description: 'Search the public web.',
    });
    context.contributions.register(authorities, WEB_EXTRACT_AUTHORITY, {
      description: 'Fetch public web pages and publish their content as artifacts.',
    });
    context.contributions.register(authorities, BROWSER_READ_AUTHORITY, {
      description: 'Open, read and capture public web pages in a browser.',
    });
    context.contributions.register(authorities, BROWSER_ACT_AUTHORITY, {
      description: 'Click, type and otherwise act on pages open in a browser.',
    });

    context.contributions.register(
      toolSets,
      'web',
      toolSetContribution({
        configSchema: WebToolSet.configSchema,
        create: (config) => new WebToolSet(config),
      }),
    );
  },
});

export { webToolsExtension };
