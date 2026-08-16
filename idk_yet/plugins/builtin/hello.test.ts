import { expect, test } from "bun:test";

import { greeters } from "../../extension-points/greeter.ts";
import { PluginHost } from "../../plugin/host.ts";
import { helloPlugin } from "./hello.ts";

test("the hello builtin has the same lifecycle as an external plugin", async () => {
  const host = new PluginHost();
  host.register(helloPlugin);

  await host.activateAll();

  const hello = host.extensions.get(greeters, "@nox/hello");
  expect(hello?.pluginId).toBe("@nox/hello");
  expect(hello?.value.greet("Nox")).toBe("Hello, Nox!");

  await host.deactivateAll();

  expect(host.extensions.has(greeters, "@nox/hello")).toBe(false);
});
