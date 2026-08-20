import { createContributionPoint } from '../contribution';

import type { ChatProvider } from '../../provider/provider';

/**
 * A provider contributes a factory, not an instance: `BaseProvider` takes its
 * config at construction and that config belongs to the `Config` service, which
 * may reload. An object rather than a bare function so later fields — display
 * name, a capability descriptor — can be added without touching a registration
 * site.
 *
 * `create` takes `unknown` because provider configuration is provider-specific:
 * the OpenAI adapter needs a `defaultModel` the base config has never heard of.
 * Each contribution validates against its own schema and throws on a mismatch,
 * which is the only place that knows what a valid config for it looks like.
 */
interface ProviderContribution {
  create(config: unknown): ChatProvider;
}

const providers = createContributionPoint<ProviderContribution>('nox.providers');

export { providers };

export type { ProviderContribution };
