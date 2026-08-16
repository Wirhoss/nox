import {
  NoxApplication,
  helloPlugin,
  greeters,
  type Logger,
} from "../index.ts";

const logger: Logger = {
  debug: (message, metadata) => console.debug(message, metadata ?? ""),
  info: (message, metadata) => console.info(message, metadata ?? ""),
  warn: (message, metadata) => console.warn(message, metadata ?? ""),
  error: (message, metadata) => console.error(message, metadata ?? ""),
};

// NoxApplication owns services, plugin state and the complete shutdown lifecycle.
const app = new NoxApplication({ logger, plugins: [helloPlugin] });
const activation = await app.start();
console.log("Activation report:", activation);

// A consumer asks for a contribution through the contract, not through the plugin.
const hello = app.plugins.extensions.get(greeters, "@nox/hello");
if (!hello) throw new Error("The hello contribution was not registered.");
console.log(hello.value.greet("Esteban"));

// Shutdown releases every resource owned by each plugin.
await app.stop();
console.log("Greeters after shutdown:", app.plugins.extensions.list(greeters).length);
