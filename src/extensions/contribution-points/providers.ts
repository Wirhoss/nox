import { z } from 'zod';

import { providerBaseConfigSchema } from '../../provider/config';
import { createContributionPoint } from '../contribution';

import type { ChatProvider } from '../../provider/provider';
import type { ConfigurableContribution } from '../contribution';

/**
 * What every provider configuration must be, whoever contributes it: the base a
 * provider is built from, plus the `type` that names which contribution built
 * it. Concrete adapters extend this — the OpenAI one adds a `defaultModel` the
 * base has never heard of — so the point can only state the floor, and states it
 * as a schema rather than a convention so `providers.json` can be validated
 * against the exact union of what is registered.
 */
const providerConfigSchema = providerBaseConfigSchema.extend({ type: z.string() });

type ProviderConfig = z.infer<typeof providerConfigSchema>;

type ProviderConfigSchema = z.ZodObject<
  { type: z.ZodLiteral<string> } & typeof providerBaseConfigSchema.shape
>;

/**
 * A provider contributes a factory and the schema of what that factory needs.
 * The schema is declared, not hidden: `providers.json` may name several
 * instances of several kinds, and the configuration module can only validate an
 * entry it has never seen the shape of by reading the schema of the contribution
 * its `type` names.
 */
type ProviderContribution = ConfigurableContribution<ProviderConfigSchema, ChatProvider>;

/**
 * Preserves the concrete schema type at the declaration site so `create` receives
 * the adapter's own config rather than the floor every provider shares.
 */
function providerContribution<TSchema extends ProviderConfigSchema>(
  contribution: ConfigurableContribution<TSchema, ChatProvider>,
): ConfigurableContribution<TSchema, ChatProvider> {
  return contribution;
}

const providers = createContributionPoint<ProviderContribution>('nox.providers');

export { providerConfigSchema, providerContribution, providers };

export type { ProviderConfig, ProviderConfigSchema, ProviderContribution };
