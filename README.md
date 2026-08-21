# Nox

Nox is a containerized, multi-agent runtime whose defining property is that a
long-running session stays cheap: its logical request head stays deterministic,
context is reduced before it is ever summarized, anything a program can do is
done by a program instead of a prompt, and every concrete capability enters as a
contribution rather than an import.

[NOX.md](NOX.md) is the definition of record — the three laws, the vocabulary,
what is deferred and why. This file only describes how to work in the repo.

## Development

```bash
bun install
bun run check     # typecheck + lint + format + tests, green on every commit
```

Individual steps: `bun run typecheck`, `bun run lint`, `bun run format`,
`bun test ./src/`.

## Running it

```bash
export OPENAI_API_KEY=sk-...          # required
export OPENAI_MODEL=gpt-4o-mini       # required: the model id to talk to
export OPENAI_BASE_URL=...            # optional, defaults to the OpenAI API
export CONFIG_DIR=./.nox/config       # optional, see src/config/env.ts
export DATA_DIR=./.nox/data           # optional: where nox.db is written
export NOX_SESSION_ID=my-session      # optional: resumes that session

bun run start
```

The first run writes `app.json` into `CONFIG_DIR` with defaults and migrates a
SQLite database into `DATA_DIR`. Type to talk; `/exit` or Ctrl-C ends the
session. Replies stream to stdout and every log line goes to stderr, so
`bun run start 2>/dev/null` gives you the conversation alone.

Anything that speaks the OpenAI Chat Completions API works — point
`OPENAI_BASE_URL` at it.

Tool sets are configured as instances in `toolsets.json` and granted from a
blueprint as either direct or routed. The builtin `web` kind can expose SearXNG
search, Crawl4AI extraction, or both:

`toolsets.json`:

```json
{
  "internet": {
    "type": "web",
    "search": { "url": "http://localhost:8081" },
    "extract": { "url": "http://localhost:11235" }
  }
}
```

The corresponding field inside `blueprints/nox.json`:

```json
{
  "toolSets": { "direct": [], "routed": ["internet"] }
}
```

## Kernel and contributions

Nox is a **kernel** plus **contributions**. The kernel owns the laws and imports
nothing concrete: when it needs a capability it declares a *contribution point*,
and something fills it. Builtins are contributions too — they differ from
third-party code only in how they are loaded, never in what they are.

| Term | Meaning |
|---|---|
| **Contribution point** | A typed slot the kernel declares. `ContributionPoint<T>` |
| **Contribution** | A concrete capability registered against a point |
| **Extension** | A packaged unit of contributions with a lifecycle. One extension may fill several points |
| **Service** | A host-owned dependency handed out by token, never a global |

## Writing an extension

An extension declares its identity and the range of Nox it accepts, then
contributes through typed points:

```ts
import { NoxApplication } from './src/application';
import { createContributionPoint, defineExtension } from './src/extensions';

interface Greeter {
  greet(name: string): string;
}

// Contribution points are declared by whoever owns the contract — in practice
// the kernel, in `src/extensions/contribution-points/`.
const greeters = createContributionPoint<Greeter>('nox.greeters');

const spanish = defineExtension({
  manifest: { engines: { nox: '^0.1.0' }, id: 'nox.greeters.spanish' },
  activate(context) {
    context.contributions.register(greeters, 'spanish', {
      greet: (name: string) => `hola, ${name}`,
    });
  },
});

const app = new NoxApplication({ extensions: [spanish] });
await app.start();

for (const contribution of app.contributions.list(greeters)) {
  console.log(contribution.extensionId, contribution.value.greet('nox'));
}

await app.stop();
```

What the runtime guarantees:

- **Identity and compatibility are validated.** A malformed ID or an `engines.nox`
  range semver cannot parse fails at the declaration site. Compatibility with the
  running `NOX_VERSION` is checked for *every* extension before any of them
  activates.
- **Every contribution is attributed** to the extension that registered it, and
  a point rejects a contribution ID that is already taken.
- **Resources are owned through `context.subscriptions`.** Anything added there
  is tracked from the moment it is acquired, so an extension that fails halfway
  through activation still releases what it took. Teardown runs in reverse
  registration order.
- **`context.signal` is aborted before cleanup starts.**
- **There are no globals.** Each `NoxApplication` owns one service collection and
  one contribution registry, so tests and multiple runtimes stay isolated.

Builtins are contributions too, and they are whole ones: each lives in its own
directory under `src/extensions/builtin/<contribution-point>/`, holding both the
capability and the extension that registers it. Providers and tool sets therefore
live under `builtin/providers/` and `builtin/toolsets/`, respectively. Nothing else
in the tree may import one —
`src/boundaries.test.ts` fails the build if it does — so a builtin can be
published as its own package later by moving the directory.

`NoxApplication` is deliberately *not* a plugin host: no dependency resolution,
no activation rollback, no degraded startup, no hot unload. That machinery waits
in `idk_yet/plugin/host.ts` until a contribution has to load from outside this
repo or fail without taking the process down.

## What exists today

| Area | State |
|---|---|
| Context engine — transcript, fold, compact, tokens, bounded BM25 retrieval | Ported and tested |
| Agent, session, runner, event log, session store | Ported and tested |
| Contribution contract, `NoxApplication` | Ported and tested |
| Tools, tool sets, the `search_tool`/`call_tool` router | Ported and tested |
| Config (zod-validated sections), SQLite via Drizzle, logger | Ported and tested |
| Provider layer | `BaseProvider`, `ChatProvider`, `ProviderStream` and retries |
| OpenAI Chat Completions, as a self-contained builtin provider extension | Ported and tested |
| Configurable tool-set contributions and blueprint grants | Ported and tested |
| SearXNG search and Crawl4AI extraction builtin tool set | Ported and tested |

Deferred, each with the trigger that un-defers it, in
[NOX.md](NOX.md#v1-scope): extension machinery, memory, web UI, message brokers,
blueprints, gates, embedding retrieval, apps, multi-provider.

## Repository layout

```
src/agent/          agent, session, runner, and the context engine
src/extensions/     the contribution contract; contribution-points/ is what Nox accepts
src/extensions/builtin/   builtins grouped by contribution point, then package
src/provider/       the provider contract: BaseProvider, ChatProvider, streaming
src/tool/           tools, tool sets, the router
src/config/         zod-validated configuration sections
src/database/       Drizzle schema, migrations and the session store
src/application.ts  the composition root
```

`ULTRA_OLD_DO_NOT_CHECK/` and `idk_yet/` are previous generations, kept as
reference while the port completes. Nothing in `src/` may import from them.
