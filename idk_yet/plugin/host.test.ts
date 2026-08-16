import { describe, expect, test } from "bun:test";

import { toDisposable } from "./disposable.ts";
import { createExtensionPoint } from "./extension.ts";
import { PluginActivationError } from "./errors.ts";
import { PluginHost } from "./host.ts";
import type { PluginManifest, NoxPlugin } from "./index.ts";
import { createServiceToken } from "./service.ts";

function manifest(
  id: string,
  dependencies?: Record<string, string>,
  optionalDependencies?: Record<string, string>,
): PluginManifest {
  return {
    id,
    version: "1.0.0",
    apiVersion: 1,
    engines: { nox: "^0.1.0" },
    dependencies,
    optionalDependencies,
  };
}

function plugin(
  id: string,
  activate: NoxPlugin["activate"],
  options: {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    deactivate?: NoxPlugin["deactivate"];
  } = {},
): NoxPlugin {
  return {
    manifest: manifest(id, options.dependencies, options.optionalDependencies),
    activate,
    deactivate: options.deactivate,
  };
}

describe("PluginHost", () => {
  test("activates required dependencies first and exposes typed contributions", async () => {
    const models = createExtensionPoint<{ generate(): string }>("nox.models");
    const order: string[] = [];
    const host = new PluginHost();

    host.register(
      plugin(
        "test.consumer",
        (context) => {
          order.push("consumer");
          expect(context.extensions.get(models, "test.model")?.value.generate()).toBe("hello");
        },
        { dependencies: { "test.provider": "^1.0.0" } },
      ),
    );
    host.register(
      plugin("test.provider", (context) => {
        order.push("provider");
        context.extensions.register(models, "test.model", { generate: () => "hello" });
      }),
    );

    const report = await host.activateAll();

    expect(report.failed).toEqual([]);
    expect(order).toEqual(["provider", "consumer"]);
    expect(host.extensions.has(models, "test.model")).toBe(true);
  });

  test("rolls back every owned resource when activation fails", async () => {
    const tools = createExtensionPoint<string>("nox.tools");
    const events: string[] = [];
    const host = new PluginHost();

    host.register(
      plugin("test.broken", (context) => {
        context.extensions.register(tools, "test.temporary", "temporary");
        context.subscriptions.add(toDisposable(() => {
          events.push("disposed");
        }));
        throw new Error("boom");
      }),
    );

    await expect(host.activate("test.broken")).rejects.toBeInstanceOf(PluginActivationError);
    expect(host.extensions.has(tools, "test.temporary")).toBe(false);
    expect(events).toEqual(["disposed"]);
    expect(host.getStatus("test.broken")?.state).toBe("failed");
  });

  test("deactivates dependents first and disposes resources in reverse order", async () => {
    const events: string[] = [];
    const host = new PluginHost();

    host.register(
      plugin("test.base", (context) => {
        context.subscriptions.add(toDisposable(() => {
          events.push("base:first");
        }));
        context.subscriptions.add(toDisposable(() => {
          events.push("base:last");
        }));
      }),
    );
    host.register(
      plugin(
        "test.dependent",
        () => undefined,
        {
          dependencies: { "test.base": "1.x" },
          deactivate: () => {
            events.push("dependent:deactivate");
          },
        },
      ),
    );

    await host.activateAll();
    await host.deactivate("test.base");

    expect(events).toEqual(["dependent:deactivate", "base:last", "base:first"]);
    expect(host.getStatus("test.base")?.state).toBe("inactive");
    expect(host.getStatus("test.dependent")?.state).toBe("inactive");
  });

  test("continues in degraded mode when a dependency is missing", async () => {
    const host = new PluginHost();
    let healthyActivated = false;

    host.register(
      plugin("test.blocked", () => undefined, {
        dependencies: { "test.missing": "^1.0.0" },
      }),
    );
    host.register(plugin("test.healthy", () => {
      healthyActivated = true;
    }));

    const report = await host.activateAll();

    expect(healthyActivated).toBe(true);
    expect(report.activated).toContain("test.healthy");
    expect(report.failed.map((failure) => failure.pluginId)).toEqual(["test.blocked"]);
  });

  test("detects dependency cycles without blocking unrelated plugins", async () => {
    const host = new PluginHost();

    host.register(plugin("test.a", () => undefined, {
      dependencies: { "test.b": "*" },
    }));
    host.register(plugin("test.b", () => undefined, {
      dependencies: { "test.a": "*" },
    }));
    host.register(plugin("test.c", () => undefined));

    const report = await host.activateAll();

    expect(report.activated).toEqual(["test.c"]);
    expect(report.failed.map((failure) => failure.pluginId).sort()).toEqual(["test.a", "test.b"]);
  });

  test("injects typed host services and locks them after startup", async () => {
    const clock = createServiceToken<{ now(): number }>("nox.clock");
    const host = new PluginHost().provideService(clock, { now: () => 42 });
    let observed = 0;

    host.register(plugin("test.clock-reader", (context) => {
      observed = context.services.get(clock).now();
    }));

    await host.activateAll();

    expect(observed).toBe(42);
    expect(() => host.provideService(createServiceToken("nox.late"), {})).toThrow();
  });
});
