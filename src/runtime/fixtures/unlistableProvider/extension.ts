import {
  BaseProvider,
  defineExtension,
  providerBaseConfigSchema,
  providerContribution,
  providers,
  z,
} from '@nox/extension-api';

import type { ModelKind } from '@nox/extension-api';

const configSchema = providerBaseConfigSchema.extend({
  type: z.literal('unlistable_test'),
});

/**
 * A provider that cannot say what it serves.
 *
 * Not every endpoint has a model list, and one that is merely unreachable
 * refuses the same question in the same way. It exists so that an empty catalog
 * is never mistaken for an endpoint that answered with nothing: the surface has
 * to be able to tell an operator why there is nothing to choose from.
 */
class UnlistableProvider extends BaseProvider {
  public fetchModelIds(): Promise<string[]> {
    return Promise.reject(new Error('This endpoint publishes no model list.'));
  }

  public supports(kind: ModelKind): boolean {
    return kind === 'chat';
  }
}

const unlistableProviderExtension = defineExtension({
  activate(context) {
    context.contributions.register(
      providers,
      'unlistable_test',
      providerContribution({
        configSchema,
        create: (config) => new UnlistableProvider(config),
      }),
    );
  },
});

export default unlistableProviderExtension;
export { unlistableProviderExtension };
