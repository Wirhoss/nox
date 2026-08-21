import { toolSetContribution, toolSets } from '../../../contribution-points/toolsets';
import { defineExtension } from '../../../extension';
import { WebTools } from './webTools';

/** Contributes the builtin SearXNG/Crawl4AI web tool set. */
const webToolsExtension = defineExtension({
  manifest: { engines: { nox: '^0.1.0' }, id: 'nox.toolset.web' },
  activate(context) {
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
