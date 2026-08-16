import { describe, expect, test } from "bun:test";

import { greeters } from "./extension-points/greeter.ts";
import { NoxApplication } from "./nox_application.ts";
import { toDisposable } from "./plugin/disposable.ts";
import type { NoxPlugin } from "./plugin/plugin.ts";
import { createServiceToken } from "./plugin/service.ts";
import { helloPlugin } from "./plugins/builtin/hello.ts";

function testPlugin(id: string, activate: NoxPlugin["activate"]): NoxPlugin {
  return {
    manifest: {
      id,
      version: "1.0.0",
      apiVersion: 1,
      engines: { nox: "^0.1.0" },
    },
    activate,
  };
}

describe("NoxApplication", () => {
  test("owns plugin and service state through one application instance", async () => {
    const clock = createServiceToken<{ now(): number }>("nox.clock");
    let observed = 0;
    const app = new NoxApplication({
      plugins: [
        helloPlugin,
        testPlugin("test.service-reader", (context) => {
          observed = context.services.get(clock).now();
        }),
      ],
    }).provideService(clock, { now: () => 42 });

    expect(app.state).toBe("created");
    const report = await app.start();

    expect(app.state).toBe("running");
    expect(report.failed).toEqual([]);
    expect(observed).toBe(42);
    expect(app.plugins.extensions.get(greeters, "@nox/hello")?.value.greet("Nox"))
      .toBe("Hello, Nox!");

    await app.stop();

    expect(app.state).toBe("stopped");
    expect(app.signal.aborted).toBe(true);
    expect(app.plugins.extensions.has(greeters, "@nox/hello")).toBe(false);
  });

  test("aborts plugin work before disposing plugin resources", async () => {
    let pluginWasAborted = false;
    let appWasAborted = false;
    const app = new NoxApplication({
      plugins: [testPlugin("test.lifecycle", (context) => {
        context.subscriptions.add(toDisposable(() => {
          pluginWasAborted = context.signal.aborted;
          appWasAborted = app.signal.aborted;
        }));
      })],
    });

    await app.start();
    await app.stop();

    expect(pluginWasAborted).toBe(true);
    expect(appWasAborted).toBe(true);
  });

  test("disposes app resources after plugins and rejects late configuration", async () => {
    const order: string[] = [];
    const app = new NoxApplication({
      plugins: [testPlugin("test.cleanup", (context) => {
        context.subscriptions.add(toDisposable(() => {
          order.push("plugin");
        }));
      })],
    });
    app.own(toDisposable(() => {
      order.push("application");
    }));

    await app.start();

    expect(() => app.registerPlugin(helloPlugin)).toThrow();
    expect(() => app.provideService(createServiceToken("nox.late"), {})).toThrow();

    await app.stop();
    expect(order).toEqual(["plugin", "application"]);
  });
});
