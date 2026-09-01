import { defineExtension, providers } from '@nox/extension-api';
import { z } from 'zod';

import type { ExtensionContext } from '@nox/extension-api';

/**
 * An extension that contributes a provider, which is the one contribution point
 * that cannot cross a process boundary yet.
 *
 * Providers stream, and streaming is its own crossing. This fixture is what an
 * installed package that Nox cannot confine yet looks like, so the refusal can
 * be pinned to the moment it happens: activation, by name.
 */
export default defineExtension({
  activate: (context: ExtensionContext) => {
    context.contributions.register(providers, 'mimic_completions', {
      configSchema: z.object({ type: z.literal('mimic_completions') }),
      create: () => ({}),
    } as never);
  },
});
