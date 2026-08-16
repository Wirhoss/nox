import { createExtensionPoint } from "../plugin/extension.ts";

/** Contract owned by Nox. Plugins provide implementations of it. */
export interface GreeterContribution {
  greet(name: string): string;
}

/**
 * A typed slot shared by the host, producers and consumers.
 * Creating the point does not register any implementation.
 */
export const greeters = createExtensionPoint<GreeterContribution>("nox.greeters");
