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
export CONFIG_DIR=./.nox/config       # optional, see src/config/env.ts
export DATA_DIR=./.nox/data           # optional: database and local secret key
export UI_DIR=./src/ui/dist           # optional: output of `bun run build:ui`
export NOX_SESSION_ID=my-session      # optional: resumes that session

bun run build:ui
bun run start
```

The first run writes `app.json` into `CONFIG_DIR` with defaults and migrates a
SQLite database into `DATA_DIR`. Type to talk; `/exit` or Ctrl-C ends the
session. Replies stream to stdout and every log line goes to stderr, so
`bun run start 2>/dev/null` gives you the conversation alone.

Anything that speaks the OpenAI Chat Completions API works — point
`OPENAI_BASE_URL` at it.

Credentials never belong inline in ordinary configuration. Nox manages them as encrypted records in
its database; an authenticated administrative surface can create, replace and delete values through the
host `SecretStore`, but cannot read them back. Configuration contains only a global reference:

```json
{ "apiKey": { "$secret": "OPENAI_API_KEY" } }
```

The store generates `.secret-key` in `DATA_DIR` with owner-only permissions. Back up that key together
with the database: losing it makes the encrypted values intentionally unrecoverable. Values are handed
to configured contributions as redacted snapshot handles, so rotating a secret requires restarting its
existing consumers. Environment variables and mounted secret directories are not alternate sources.

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

`web_extract` returns bounded readable Markdown and the image candidates Crawl4AI found.
`web_view_image` then returns a chosen candidate as image content, so a multimodal model receives
pixels through its provider adapter rather than an alt string or URL disguised as a tool result.

Model modalities are explicit metadata. A model is text-only until its exact configuration declares
additional inputs; model IDs are never used as a capability database:

```json
{
  "modelId": "vision-model",
  "contextWindow": 131072,
  "inputModalities": ["text", "image"],
  "outputModalities": ["text"]
}
```

Input and output capabilities are independent: a vision model can accept `image` while producing
only `text`. The content envelope itself supports `text`, `image`, `audio`, `video`, and `document`.
A provider
adapter must encode every modality it supports and reject the others explicitly. The current OpenAI
Chat Completions adapter encodes text and images; it does not silently discard declared audio, video,
or document input.

### Models for internal tasks

An agent answers people on the `provider`/`model` its blueprint names. Nox also
talks to itself: it compacts the working set when the context comes under
pressure, and it names a session after its first exchange so a list of
conversations reads as something other than ids. Neither is the agent answering
anybody, so neither has to run on the agent's model:

```json
{
  "taskModels": {
    "compaction": { "model": "qwen38-27b", "provider": "big" },
    "title": { "model": "qwen38-4b" }
  }
}
```

Every entry is optional and every absent one falls back to the agent's own
provider and model. An entry that names only a `model` stays on the agent's
provider — the usual case is a cheaper model on the endpoint already configured.

A session is named once, after its first completed run, out of turn: the reply
is already delivered when the request goes out, and a titling call that is slow
or fails leaves the session with the id it already had. A session opened with a
title given to it is never renamed.

## The web broker

A **broker** is a transport into the message gateway — it delivers what arrived
and renders what it is handed, and knows nothing about agents, sessions or the
transcript. The builtin `web` broker is Nox's own HTTP surface acting as one: it
does not dial out, it is handed connections by the browser, and its ingress rule
is the access token the API already checks.

The web broker is not an entry in `brokers.json`. It is internal infrastructure:
bootstrap creates exactly one, reserves the broker ID `web`, and attaches it
before the API starts listening. `brokers.json` is only for transports that reach
external services.

With one blueprint, web conversations use that agent automatically. With more
than one, choose the temporary default in `app.json` until the web surface offers
an agent picker:

```json
{ "chat": { "defaultAgent": "nox" } }
```

The authenticated installation owner receives every registered authority on
this broker. The Gate still evaluates concrete risk and asks for approval where
required; copying an account ID into configuration is neither necessary nor
supported.

Its routes are mounted only when authentication is configured, and every one of
them requires a token:

| Route | What it does |
|---|---|
| `GET /api/chat/stream` | Server-sent events for every conversation, named by event type |
| `POST /api/chat/conversations/:conversationId/messages` | Says structured `content` (or legacy `text`); answers `202`, the reply arrives on the stream |
| `POST /api/chat/conversations/:conversationId/permissions/:requestId` | Answers a pending gate request with `{ "decision": "approve", "scope": "session" }` or `{ "decision": "deny" }` |

A conversation is named by the client and bound to a session by the runtime on
the first message it carries: there is no endpoint that creates one, because a
chat nobody has spoken in is not yet a session. The binding survives a restart,
like any other broker's.

### What a broker receives

What a run produces and what a surface shows are different questions, and the
second one belongs to the transport. Every event a session emits is offered to
every broker, and each one declares what it renders through `BrokerCapabilities`:

| Capability | What it turns on |
|---|---|
| `streaming` | The reply as it is being written |
| `permissions` | Gate requests, and their resolutions |
| `reasoning` | What the model thought — settled, and live when `streaming` is on too |
| `toolActivity` | The calls the agent made and what came back |
| `runs` | When a run started, how it ended, and whether it was truncated |
| `retries` | Provider failures being retried rather than reported |
| `contextChanges` | Fold and compaction rewriting the context |
| `titles` | The name a session gave itself after its first exchange |
| `usage` | Token accounting, per model call and as a run total |

A broker that declares nothing gets the settled reply and nothing else, which is
what a bot in a channel wants. The `web` broker declares all of them: it is not a
chat client, it is a surface over the runtime, and a client on the other end
decides what it draws.

Two things stay with the gateway because they are not rendering questions: what
another participant said, and which principal was allowed to use which authority.
Both are about who may see what.

Two things it deliberately does not do yet. Nothing is replayed to a client that
reconnects — an event delivered while no stream is open is dropped, and reading
a transcript back is a surface Nox does not have. And a run in flight cannot be
stopped from here: the gateway's inbound events are messages and permission
answers, and a stop button is a change to that contract rather than to this
broker.

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
| Message gateway, and the `web` broker over the HTTP surface | Built and tested |

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
