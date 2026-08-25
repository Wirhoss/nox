import { authorities } from '../../../contribution-points/authorities';
import {
  defineTranslationFragment,
  translationFragments,
} from '../../../contribution-points/languages';
import { toolSetContribution, toolSets } from '../../../contribution-points/toolsets';
import { defineExtension } from '../../../extension';
import { englishMessages } from './messages';
import { spanishMessages } from './messages.es';
import {
  BROWSER_ACT_AUTHORITY,
  BROWSER_EVALUATE_AUTHORITY,
  BROWSER_READ_AUTHORITY,
} from './tools/browser';
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
    // Separate permissions because searching, downloading, reading a browser,
    // acting on a page and executing arbitrary page JavaScript are materially
    // different things to grant. An agent can inspect a browser it may not touch,
    // and evaluation remains independently grantable even when explicitly
    // enabled in module configuration.
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
    context.contributions.register(authorities, BROWSER_EVALUATE_AUTHORITY, {
      description: 'Execute arbitrary JavaScript in the context of an open browser page.',
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
