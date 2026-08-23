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
  WEB_EXTRACT_AUTHORITY,
  WEB_SEARCH_AUTHORITY,
  WEB_VIEW_IMAGE_AUTHORITY,
  WebTools,
} from './webTools';

/** Contributes the builtin SearXNG/Crawl4AI web tool set. */
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
    context.contributions.register(authorities, WEB_SEARCH_AUTHORITY, {
      description: 'Search the public web.',
    });
    context.contributions.register(authorities, WEB_EXTRACT_AUTHORITY, {
      description: 'Fetch and extract the readable content of public web pages.',
    });
    context.contributions.register(authorities, WEB_VIEW_IMAGE_AUTHORITY, {
      description: 'Present a public web image to a multimodal model.',
    });

    context.contributions.register(
      toolSets,
      'web',
      toolSetContribution({
        configSchema: WebTools.configSchema,
        create: (config) => new WebTools(config),
      }),
    );
  },
});

export { webToolsExtension };
