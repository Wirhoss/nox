import { greeters } from "../../extension-points/greeter.ts";
import { definePlugin, toDisposable } from "../../plugin/index.ts";

/** A builtin uses exactly the same public plugin API as an external plugin. */
export const helloPlugin = definePlugin({
  manifest: {
    id: "@nox/hello",
    displayName: "Hello",
    description: "Example builtin plugin that contributes a greeter.",
    version: "1.0.0",
    apiVersion: 1,
    engines: {
      nox: "^0.1.0",
    },
  },

  activate(context) {
    context.logger.info("Activating the example builtin.");

    // The host attributes this contribution to @nox/hello and owns its cleanup.
    context.extensions.register(greeters, "@nox/hello", {
      greet(name) {
        return `Hello, ${name}!`;
      },
    });

    // Plugins can attach any other resource to the same lifecycle scope.
    context.subscriptions.add(
      toDisposable(() => {
        context.logger.info("Cleaning up the example builtin.");
      }),
    );
  },
});
