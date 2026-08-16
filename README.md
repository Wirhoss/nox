# Nox

Nox is being rebuilt around a first-class plugin architecture.

## Development

```bash
bun install
bun run check
```

## Plugin kernel

A plugin declares its identity, compatibility and dependencies, then contributes capabilities through typed extension points.

```ts
import {
  NoxApplication,
  createExtensionPoint,
  definePlugin,
} from "./index.ts";

interface ToolContribution {
  description: string;
  execute(input: unknown): Promise<unknown>;
}

const tools = createExtensionPoint<ToolContribution>("nox.tools");

const example = definePlugin({
  manifest: {
    id: "example.tools",
    version: "1.0.0",
    apiVersion: 1,
    engines: { nox: "^0.1.0" },
  },
  activate(context) {
    context.extensions.register(tools, "example.echo", {
      description: "Returns its input",
      async execute(input) {
        return input;
      },
    });
  },
});

const app = new NoxApplication({ plugins: [example] });
await app.start();
// ...use Nox...
await app.stop();
```

## Runnable builtin example

The repository includes a builtin plugin implemented only through the public API:

```text
src/extension-points/greeter.ts  contract owned by Nox
src/plugins/builtin/hello.ts     plugin implementation
examples/plugin-demo.ts          application bootstrap and consumer
```

Run it with:

```bash
bun run example:plugin
```

The separation is intentional: consumers know the `greeters` extension point, but do not depend on `helloPlugin`. This allows another plugin to provide a different implementation without changing the consumer or the kernel.

## Application ownership

`NoxApplication` is the composition root. Each instance owns one `ServiceCollection`, one `PluginHost`, application resources, cancellation and lifecycle state. There are no global registries, so tests and multiple runtimes remain isolated.

The kernel currently provides:

- runtime-validated manifests and semantic-version compatibility;
- required and optional plugin dependencies;
- deterministic activation and reverse-order deactivation;
- activation rollback and plugin-owned disposable resources;
- degraded startup when unrelated plugins fail;
- typed extension points and host services;
- clean unload of dependent plugins;
- per-plugin cancellation signals before cleanup;
- one application-owned service collection and shutdown lifecycle.

Plugins currently run in-process and must be trusted. Isolation belongs to a later execution-runtime layer.
