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
export EXTENSIONS_DIR=./.nox/extensions # optional: installed extension packages
export UI_DIR=./src/ui/dist           # optional: output of `bun run build:ui`
export NOX_SESSION_ID=my-session      # optional: resumes that session

bun run build:ui
bun run start
```

`app.json` holds one setting worth naming here: `timezone`, an IANA zone such as
`America/Mexico_City`, defaulting to `UTC`. Every message a model is shown
carries the moment it was said in that zone — `[from esteban · 2026-08-23 14:14
GMT-6]` — which is how an agent knows what day it is. Nothing injects a live
clock into the system prompt: the newest message in the history already is the
current time, so the cached prefix of a request never moves for the model to read
it, and a replayed request renders byte-for-byte as it did the first time.

The first run writes `app.json` into `CONFIG_DIR` with defaults and migrates a
SQLite database into `DATA_DIR`. Type to talk; `/exit` or Ctrl-C ends the
session. Replies stream to stdout and every log line goes to stderr, so
`bun run start 2>/dev/null` gives you the conversation alone.

## Extensions

Nox discovers extension packages at startup from two roots:

- The runtime-owned `extensions/builtin` directory beside Nox: packages shipped in the image. Its
  location is intentionally not configurable.
- `EXTENSIONS_DIR`: locally installed packages, defaulting to `DATA_DIR/extensions`.

Origin is inventory metadata, not a different execution path. Both roots use the same manifest parser,
compatibility checks, module loader, activation context, contribution registry and failure isolation.
No concrete builtin is imported by `bootstrap.ts`. A broken or incompatible package is reported by the
control plane without being activated, while healthy packages continue to start.

An extension is one directory containing a manifest and a JavaScript entry module:

```text
example.toolset/
├── nox-extension.json
└── extension.js
```

```json
{
  "schemaVersion": 1,
  "id": "example.toolset",
  "version": "1.4.2",
  "main": "extension.js",
  "engines": {
    "nox": "^0.1.0",
    "extensionApi": ">=0.1.0 <0.2.0"
  }
}
```

`version` identifies one exact installed artifact. Both compatibility declarations are semver **ranges**:
an extension can support a family of Nox and Extension API releases rather than naming one build.
The entry module default-exports a definition created with the versioned `@nox/extension-api` package:

```ts
import { defineExtension } from '@nox/extension-api'

export default defineExtension({
  activate(context) {
    // Register contributions and owned resources through context.
  },
})
```

Extensions can contribute person-facing commands too. The contribution ID is the slash-command name;
its Zod parameters become the JSON Schema rendered by Web or Discord and are validated again by the
host. Every extension command declares an authority and the concrete risk of its invocation, so it goes
through authorization and the session Gate before running:

```ts
import { authorities, commands, defineCommand, defineExtension, z } from '@nox/extension-api'

export default defineExtension({
  activate(context) {
    context.contributions.register(authorities, 'example.extension.commands', {
      description: 'Run the example extension commands.',
    })
    context.contributions.register(
      commands,
      'hello',
      defineCommand({
        authority: 'example.extension.commands',
        description: 'Greets someone without entering the model transcript.',
        parameters: z.object({ name: z.string() }),
        risk: () => ({ effects: [] }),
        run: async (_command, { name }) => ({ text: `Hello, ${name}.` }),
      }),
    )
  },
})
```

Command code receives a bounded conversation context rather than Nox's internal `Session` or database.
It may inspect the current session, compact or rename it, retry generation, start a new session, and
explicitly switch its agent or model. Results are delivered as command events and never become words the
model reads.

The autonomous package source lives in `packages/extension-api`. It imports no kernel modules and its
build emits ESM JavaScript plus TypeScript declarations under `dist`. Extension projects use it as a
development dependency and keep `@nox/extension-api` external in their production bundle; Nox supplies
the runtime selected by `engines.extensionApi`. Builtins obey the same boundary: production builtin
code can import only its own package files and the public API. A complete independently compiled
consumer is available at `examples/extensions/greeting-toolset`.

The manifest owns identity; extension code does not duplicate or override it. Entry points are confined
to their package directory, duplicate IDs disable every conflicting candidate, and activation failure
rolls back that package's contributions. Each activation receives `context.storage`, an atomic durable
JSON store isolated by extension ID; no extension receives Nox's database connection or schemas.
Extensions are trusted native code, not a sandbox, and package changes currently require a Nox restart.

#### Pending: extension isolation and privilege

"Trusted native code" is the whole of the current model, and the sentence above is doing more work than
it looks like it is. The loader `import()`s a package from disk into the Nox process, so an extension
runs with everything the runtime has: the data directory and its `.secret-key`, the SQLite database,
the network, the filesystem. `SecretMetadataReader` deliberately exposes metadata and never values, and
`context.storage` is isolated per extension ID, but neither is a boundary — they are conveniences that
an extension can simply decline to use.

That is acceptable while every package ships in the image, and it stops being acceptable the moment a
person can install a third-party one. What un-defers this is exactly that: an install path that accepts
a package Nox did not build. It needs, at least:

- a declared permission model in the manifest — filesystem, network, services — that the host enforces
  rather than documents;
- an execution boundary an extension cannot reach around, whether that is a worker with a restricted
  module graph, a separate process behind the existing typed-token RPC, or WASM for the pure cases;
- `origin` meaning a privilege level instead of an inventory label;
- an install-time disclosure that says plainly what the package will be able to reach.

Until then, installing an extension is granting the machine, and any UI that offers installation has to
say so in those words.

#### Pending: the size of the public surface

`@nox/extension-api` is now the single declaration of types the kernel also consumes — `Message`,
`MessageContent`, `MessageOrigin` and the whole outbound event vocabulary live there rather than in
`src/`. That removes duplication and the drift that comes with it, and it moves the coupling instead of
removing it: a change to a kernel domain type is now a change to a versioned public contract.

The contract tests cover schema behavior, not the shape of every exported interface, and the package is
committed under semver before a single third-party extension has exercised it. `0.x` is the room to be
wrong in; the discipline is to spend it deliberately — when a real external consumer appears, expect one
compaction pass of the surface, and take it while the major is still `0`.

The builtin `nox.commands.session` extension contributes `/commands`, `/help`, `/session`, `/tools`,
`/compact`, `/retry`, `/rename`, `/new`, `/agent`, and `/model`; `/stop` remains the host safety command. Bare
`/agent` and `/model` list choices. Supplying one value switches explicitly: an agent handoff starts a
fresh linked session so two agents never share one transcript, while a model switch reopens the same
transcript under a model available from that agent's configured provider. Web accepts either JSON
(`/agent {"agent":"worker"}`) or shorthand (`/agent worker`) for a one-value command.

Authenticated owners can inspect discovery and activation state through `GET /api/extensions`. The
response includes Extension API version, package origin/version/state, sanitized errors and contributed
IDs, but no absolute filesystem paths. Discovering an extension never silently creates a configured
instance: Settings or configuration still creates and grants them explicitly.

How many instances a contribution can have is the contribution's own declaration, not a property of the
section it belongs to. `instances` defaults to `single`, because that is the ordinary case — a transport
is bound to one credential, and a capability like scheduling or configuration access belongs to this Nox
rather than to a service outside it. `many` is the exception a contribution states out loud, and it is
right when an instance is the address of an independent remote service a deployment genuinely wants
several of, with consumers choosing between them. Today that is the OpenAI-compatible provider
adapter; Nox's local memory is deliberately a singleton.

A `single` contribution owns its own name: its entry must be called exactly what the contribution is
called, which is also its config `type`. One rule does two jobs — it reserves the name, so `web` is the
browser transport's by being called `web`, and it makes a second instance impossible, because two
entries cannot share one key. Configuration says so when it is broken, for every section alike.

Because a `single` contribution owns its name, a section can say what it *could* hold and not only what
it holds: `GET /api/config` carries a compact `contributions` list per contributed section — type,
extension, multiplicity, and whether it is configured. Settings draws the unconfigured single-instance
ones as rows to fill in, and following one opens the create form with the type and the entry ID already
settled, since for a singleton they are the same string. Nothing writes an entry it cannot validate: a
broker stored without its credential would only come back as `failed`.

#### Upgrading: singleton entries may need renaming

The naming rule is enforced when a section loads, so a configuration written before it existed can name
a singleton's entry anything at all and stop validating on upgrade. Renaming is the whole fix, and it is
two edits rather than one: the entry in its own file, and everything that referenced the old name — a
blueprint granting a tool set, a blueprint naming a provider. The failure is reported per component
rather than fatally, and the last working generation stays in service while it is corrected.

`bun run build:extension-api` builds the publishable package directly. `bun run build:extensions` first
builds that same package, then packages every builtin separately under `dist/extensions/builtin` and
emits the runtime package under `dist/node_modules`. The container copies those outputs
rather than compiling a static builtin registry into the kernel.

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
to configured contributions as redacted snapshot handles. Rotating a secret reconciles replacement
provider, memory, tool-set, agent and broker generations; work already in flight finishes against its
immutable snapshot. Environment variables and mounted secret directories are not alternate sources.

Configuration files are durable desired state. Providers, memories, tool sets, blueprints, brokers, log
level, time zone and interface locale reconcile without a process restart; a failed candidate remains saved and
visible while its last valid generation keeps serving. Settings offers retry, revert and an explicit
**Reload mounted config** action. Set `CONFIG_WATCH=true` to add debounced filesystem reloads
(`CONFIG_WATCH_DEBOUNCE_MS`, default 250 ms). The explicit action remains available even with the
watcher enabled. HTTP listen address, SQLite structure/path, artifact storage construction and similar
process infrastructure report `restartRequired` instead of pretending they changed live.

### Long-term memory

Memory is a public contribution point rather than a vector-store contract. An adapter implements two
operations: recall bounded context before a model request, and retain the original user/assistant delta
after a run. Extraction, embeddings, consolidation, deduplication and storage policy remain the
adapter's responsibility. A blueprint can select **one** configured memory instance; Nox never merges
results from multiple backends.

The builtin implementation is Nox's own small local engine. It writes turn documents through the
extension storage backed by Nox's SQLite `extension_state` table, ranks candidates locally with a
lexical BM25 pass, and has no network service, embedding model, or external credential. Because it is a
singleton, its entry is named `local`:

```json
{
  "local": {
    "type": "local",
    "maxEntriesPerScope": 2000,
    "maxRecallItems": 12
  }
}
```

Select it in `blueprints/<agent-id>.json` and reserve the maximum recalled payload in model tokens:

```json
{
  "memory": { "id": "local", "maxTokens": 2048 }
}
```

Every SQL collection key contains both the **agent ID** and the initiating principal. Sessions of one
agent and principal form a long-term corpus, while another agent or another participant addresses a
different collection. Speech from another participant in a shared conversation is excluded rather than
silently attributed to the run owner. Oldest turns are pruned independently per scope according to
`maxEntriesPerScope`.

Hindsight, Mem0, OpenViking, or another remote engine can later implement the same public `Memory`
contract as an installed extension; none of them is linked into the builtin implementation.

Recalled text is ephemeral: it is inserted only into the provider request, never the transcript, and is
wrapped in Nox's randomized untrusted-data boundary. The configured token budget is enforced again by
Nox even if a backend returns too much. Recall and retain failures degrade to an ordinary memoryless
turn; they do not fail the conversation or broaden its scope. Retention is detached from response
latency and is drained when the session stops.

Tool sets are configured in `toolsets.json` and granted from a blueprint as
either direct or routed. A single-instance contribution owns its entry ID; the
builtin Web tool set is therefore named `web`. It has three slots — `search`,
`extract` and `browser` — and each is filled by naming the module that backs it.
A slot left empty is a tool the agents holding that tool set simply do not have:

`toolsets.json`:

```json
{
  "web": {
    "type": "web",
    "search": { "module": "searxng", "url": "http://localhost:8081" },
    "extract": { "module": "crawl4ai", "url": "http://localhost:11235" },
    "browser": { "module": "camoufox", "url": "https://camofox.example" }
  }
}
```

The fields beside `module` are that module's own: SearXNG has a language and an
engine list, Crawl4AI has captures and a batch ceiling, and camoufox has a session
owner. Modules are grouped by the slot they fill under
`src/extensions/builtin/toolsets/web/modules/{browser,extract,search}/`; adding
one means adding its file and one registry entry. Nothing else widens, and no
entry naming another module changes meaning. The settings surface builds its
form from each kind's own schema, so a new module's fields appear there without
the editor learning their names.

The browser slot can instead use Playwright. Its client is imported lazily and
the browser is started only on the first browser tool call, so an installation
that does not configure or use this module opens no Playwright process or
connection. With no `wsEndpoint`, the container launches its bundled system
Chromium and keeps one isolated browser context per named session:

```json
{
  "browser": {
    "module": "playwright",
    "browser": "chromium",
    "headless": true,
    "timeoutMs": 30000
  }
}
```

The Nox image installs Alpine's Chromium and points Playwright at it; it does not
download Playwright's browser bundle. Firefox and WebKit are available through a
remote `wsEndpoint` returned by the matching version of
`browserType.launchServer`. `apiKey` may reference a managed secret to send as a
Bearer token, and `executablePath` can override the local browser binary.

Both browser modules expose `browser_inspect`, a bounded DOM search by text or
CSS. It reports visibility, semantic and visual interaction signals, and a
unique selector, covering controls that a site's incomplete accessibility markup
leaves without snapshot refs. The routine is fixed and read-only from the tool's
perspective; it does not enable caller-supplied JavaScript.

Arbitrary page JavaScript is a separate opt-in. Setting `enableEvaluate` on the
configured browser module exposes `browser_evaluate`:

```json
{
  "browser": {
    "module": "playwright",
    "enableEvaluate": true
  }
}
```

That tool has its own `nox.toolset.web.browser.evaluate` authority and declares
credential, code-execution and irreversible page/network effects. It can read
page storage, issue requests and mutate the live document, so it remains absent
when the option is false (the default), independently of ordinary browser read
and act grants.

The corresponding field inside `blueprints/nox.json`:

```json
{
  "toolSets": { "direct": [], "routed": ["web"] }
}
```

At session open, Nox appends the names and descriptions of routed tool sets to
the runtime system context. This gives the model enough of a capability map to
decide whether to call `search_tool` and which keywords to use without paying for
every routed tool schema in the request head. The exact names and schemas
returned by `search_tool` remain authoritative.

`web_extract` returns the page as files rather than as prose: the cleaned HTML,
the pictures it found (fetched and published, bounded in count and size), and on
request a screenshot, a PDF or Markdown. The transcript keeps only what has to be
read — the title, where each file went, and a bounded excerpt — leaving
`attach_artifact` to decide what reaches the user. The browser is a family of
tools rather than one tool with an `action` argument — `browser_open`,
`browser_snapshot`, `browser_inspect`, `browser_click`, `browser_type` and the
rest — and which of them exist is the configured module's answer, so a backend
that cannot press a key never offers `browser_press`. `browser_open` hands back a
tab ID that later calls name, and every action that changes the page answers with
the page it produced: an accessibility snapshot with element refs, which is what the
next click or keystroke addresses. Reading a page and acting on one are separate
authorities, so an agent can be granted a browser it may look at and not touch,
and clicking and typing are recorded as irreversible network writes. An instance
that should expose fewer of them lists the ones it keeps in `enabledTools`.

### Agent-managed configuration

The builtin `config` tool-set lets an agent inspect and administer the same durable desired state as
Settings. It does not edit files behind the runtime's back: reads, schemas, entry CRUD, mounted-file
reload, activation retry and failed-change revert all pass through the shared configuration
administration boundary, including reference policy and generation reconciliation.

```json
{
  "config": {
    "type": "config",
    "readSections": ["app", "blueprints", "brokers", "memories", "providers", "toolSets"],
    "writeSections": ["blueprints", "memories", "providers", "toolSets"],
    "manageRuntime": true,
    "readSecretMetadata": true
  }
}
```

Grant the configured instance from a blueprint like any other capability:

```json
{
  "toolSets": { "direct": ["config"], "routed": [] }
}
```

It exposes `config_status`, `config_schema`, `config_list`, `config_get`, `config_toolsets`,
`config_secrets`, `config_update_app`, `config_create`, `config_replace`, `config_delete`,
`config_reload`, `config_retry`, and `config_revert`, subject to that instance policy and ordinary
`enabledTools`/blueprint cuts. Its separate authorities are `nox.toolset.config.read`,
`nox.toolset.config.write`, and `nox.toolset.config.runtime`. Configuration mutations declare
privilege and write risk, so the Gate can require explicit approval; deletion and runtime recovery
also declare their irreversible effects.

`config_secrets` returns IDs, storage state, references and consumers only. There is deliberately no
tool that accepts a secret value: passing one as a model-generated tool argument would put the
credential in provider input, transcript and audit data. An agent may configure a `{ "$secret":
"ID" }` reference and report that its value is missing, but the operator supplies or rotates that
value through the write-only Settings surface.

The configuration snapshot held by a live session remains stable. An agent may change its own
blueprint or remove this grant for future sessions; the current tool call finishes against the
generation with which it started.

### Scheduled jobs

The builtin `cronjobs` tool-set runs durable automations in fresh sessions of selected configured
agents. Configure one instance in `toolsets.json` and grant its management tools directly:

```json
{
  "cronjobs": {
    "type": "cronjobs",
    "maxJobs": 100
  }
}
```

```json
{
  "toolSets": {
    "direct": ["cronjobs"],
    "routed": ["web"]
  }
}
```

It exposes `cron_agents`, `cron_create`, `cron_list`, `cron_get`, `cron_update`, `cron_delete`, and
`cron_run`. Every job names an `agentId`. Each occurrence opens a new session with that agent's model,
system prompt, and selected tools; no authoring-chat history enters the run and no run history enters
the next occurrence. An optional delivery target names a configured broker and channel:

```json
{
  "agentId": "mail-assistant",
  "delivery": { "brokerId": "discord", "channelId": "mail-alerts" }
}
```

A schedule is either one future ISO 8601 instant (`at`) or a recurring five-field cron expression
(`cron`). Recurring jobs may name an IANA time zone; otherwise the application time zone is used. Jobs and their independent run records persist in SQLite. A
one-time job is retained disabled after it runs. Occurrences missed while Nox was stopped are recorded
as `skipped`, never replayed in a catch-up burst.

A firing acts as `nox.system:cron`, not as the person who created it. That builtin principal may use
the tools exposed by the selected agent's blueprint; it does not inherit the author's permissions or
add capabilities absent from that agent. The normal Gate still evaluates each call, and a system run
cannot approve an escalation on a human's behalf.

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

### Files and artifacts

Uploaded files do not live in messages or SQLite. The authenticated artifact API streams raw request
bytes into `DATA_DIR/artifacts`, hashes them while writing, detects their media type, and returns a
small `ArtifactRef`. Immutable blobs are addressed by SHA-256, so separate uploads retain their own
filename, provenance and access scope while identical bytes occupy disk once. SQLite stores only that
logical metadata. `app.json` bounds the stream with `artifacts.maxArtifactBytes` (100 MiB by default)
and bounds all unique original and rendition bytes with `artifacts.maxStorageBytes` (10 GiB by
default). Deduplicated references consume no additional quota; a new blob is refused before its final
path or metadata commits when storage is full.

```http
POST /api/artifacts
Authorization: Bearer …
Content-Type: image/webp
X-Artifact-Filename: diagram.webp

<raw bytes>
```

Messages carry `{ "type": "artifact", "artifact": { … } }`. The chat ingress resolves that ID again
under the authenticated account and replaces every client-supplied metadata field with the canonical
record before it reaches the transcript. Bytes are read back through the authenticated
`GET /api/artifacts/:artifactId/content` route. Conversation-owned output includes its conversation ID
in that authenticated request. The web client fetches the response as a blob; it never turns a file
into base64 JSON. Stored images are requested only when their placeholder enters the viewport, while
audio, video and documents remain references until the operator explicitly opens or downloads them.

The path is bidirectional. Every user-facing run receives a host-owned `ArtifactOutputSink`, exposed to
a provider as `TextGenerateOptions.artifactOutput` and to an executing tool as
`ToolContext.artifacts`. A producer streams bytes into `publish(...)`; Nox, not the producer, assigns
the conversation scope and provider/tool provenance, and returns a `ContentArtifact` containing only
the canonical reference. Creation does not imply presentation: tool artifacts remain tool results
until the model explicitly calls the core `attach_artifact` tool for each file it has decided the
user should receive. Tools that declare `output: { artifacts: true }` receive a provider-visible
notice explaining that selection step and forbidding inline/base64 file bytes. Those selections are
appended to the next assistant message, or emitted alone
if the run ends before another assistant turn. Native provider output is already the model's direct
answer and enters the normalized stream as an `artifact` event. Assistant messages, the transcript,
brokers and the UI all carry the same reference, and later model calls replay it as a stable
descriptor.

The companion core `read_artifact` tool inspects only IDs already referenced by the conversation.
It requests the versioned `nox.agent.text-read` representation profile: compatible textual originals
are streamed in bounded Unicode-character pages, while registered deterministic processors may
produce and cache textual renditions for formats such as PDF or Office documents. If no textual
rendition exists, the tool returns the canonical binary reference so a compatible provider can still
consume it visually or another specialized tool can handle it; it never treats arbitrary bytes as
text.

Artifact and model modality are intentionally different concepts. Consumers resolve bytes through a
versioned representation profile: accepted media types, an optional size ceiling, and deterministic
transform parameters. A compatible original is returned unchanged. Otherwise the pipeline chooses a
registered processor by explicit priority and stable ID, writes its output through the same streaming
content-addressed store, and caches the rendition by source hash, source media type, complete profile,
and processor version. Concurrent requests share the cache entry, while conflicting output under one
processor version is rejected as a determinism violation. SQLite still contains metadata only.

Every model receives an explicit textual artifact reference. When the selected model declares image
input, the OpenAI adapter asks for its concrete image profile and materializes the resolved bytes as
visual input. If no compatible rendition exists, it keeps the descriptor instead of discarding the
attachment or sending an unsupported encoding. A text-only model never materializes it.

The first concrete processor is the builtin `nox.processor.sharp` extension. It registers Sharp through
the same public processor registry available to future implementations; neither the artifact pipeline
nor OpenAI imports it. It can normalize SVG, AVIF, GIF, JPEG, PNG, TIFF and WebP into a profile's
preferred PNG, JPEG, WebP, GIF or AVIF representation, with bounded resize, fit, position, background,
quality and orientation parameters. Processing is streamed, timed out, pixel-limited, metadata-stripped
and cache-versioned with both the Sharp and libvips versions.

#### Pending: artifact retention and deletion

Storage quotas bound growth but do not delete committed artifacts automatically. A future lifecycle
pass must preserve transcript history and content-addressed deduplication rather than removing files by
age alone:

- persist normalized references from messages and active operations instead of discovering them by
  scanning JSON;
- distinguish deleting a logical `artifactId` from collecting its shared physical blob;
- support authorized deletion, pinning, expiration and a configurable grace period per scope;
- evict regenerable renditions before immutable originals;
- collect a blob only when no artifact, message, rendition source or in-flight operation references it;
- reconcile tombstones, SQLite metadata and filesystem state after crashes, with race and restart
  coverage.

Until that lifecycle exists, reaching `artifacts.maxStorageBytes` rejects new unique blobs with a 507
response; it never silently breaks an old conversation to recover space.

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

The web broker is the reserved `web` entry in `brokers.json`. A missing entry is
materialized automatically and can be disabled, but cannot be renamed or deleted
through Settings:

```json
{
  "web": { "type": "web", "agent": "nox" }
}
```

`agent` is optional for Web. With one available blueprint, Web uses it
automatically. With multiple blueprints and no configured Web agent, every new
conversation must explicitly choose one in the browser; Nox never invents an
alphabetical default. Agent routing belongs to this broker rather than to a
global `app.chat` setting.

The authenticated installation owner receives every registered authority on
this broker. The Gate still evaluates concrete risk and asks for approval where
required; copying an account ID into configuration is neither necessary nor
supported.

Its routes are mounted only when authentication is configured, and every one of
them requires a token:

| Route | What it does |
|---|---|
| `GET /api/chat/stream` | Server-sent events for every conversation, named by event type |
| `POST /api/chat/conversations/:conversationId/messages` | Sends structured `content`; answers `202`, and the reply arrives on the stream |
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

### Language extensions and extension-owned UI copy

The browser contains message keys, not an embedded English catalog. Complete languages are
contributions at `nox.languages`, and Nox exposes the active catalog through the public language API
(the access screen needs it before an account can authenticate):

| Route | Result |
|---|---|
| `GET /api/i18n/languages` | Available locales, direction, native name, fallback and configured locale |
| `GET /api/i18n/languages/:locale` | The resolved flat message catalog for one locale |

A language package is an ordinary extension:

```ts
import {
  defineLanguagePack,
  languagePacks,
} from './src/extensions/contribution-points/languages';
import { defineExtension } from './src/extensions';

const spanish = defineExtension({
  manifest: { engines: { nox: '^0.1.0' }, id: 'community.language.es' },
  activate(context) {
    context.contributions.register(
      languagePacks,
      'es',
      defineLanguagePack({
        direction: 'ltr',
        locale: 'es',
        messages: {
          'common.cancel': 'Cancelar',
          // ...the rest of the core catalog
        },
        name: 'Español',
      }),
    );
  },
});
```

Feature-specific copy does **not** belong to a core language package. The feature extension owns
all of its translated fragments and mounts each locale below its own extension namespace. A language
extension never needs to name OpenAI, Web Tools or any other optional feature:

```ts
import {
  defineTranslationFragment,
  translationFragments,
} from './src/extensions/contribution-points/languages';

context.contributions.register(
  translationFragments,
  'nox.provider.openai.es',
  defineTranslationFragment({
    locale: 'es',
    namespace: 'nox.provider.openai',
    messages: { 'ui.save': 'Guardar proveedor' },
  }),
);
```

The API prefixes that fragment as `nox.provider.openai.ui.save` and merges it only into `es`.
The API rejects a fragment whose namespace differs from the extension that registered it. Duplicate
locale/key ownership is an error rather than a load-order override. The client loads the
selected locale and the default locale, so an extension remains usable in its fallback language when
it has not translated a selected locale. Tool-set inventory also carries the contributing extension
ID, allowing its names and descriptions to resolve from that same namespace instead of being baked
into the UI.

The installation preference lives at `ui.locale` in `app.json` and is editable under
**Settings → General → Interface language**. The public access screen also offers the selector and
keeps that browser's choice locally, since it must choose a language before authentication.

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
live under `builtin/providers/` and `builtin/toolsets/`, and memories under `builtin/memories/`.
Nothing else
in the tree may import one —
`src/boundaries.test.ts` fails the build if it does — so a builtin can be
published as its own package later by moving the directory.

`NoxApplication` is deliberately *not* a dynamic plugin host: it performs no
package dependency resolution or extension hot unload. Runtime configuration is
a separate generation reconciler: provider, memory, tool-set, agent and broker failures
are isolated, last valid generations remain active, and the authenticated
Settings/control plane stays available for retry, revert and explicit mounted-file
reload. External extension package loading still waits in `idk_yet/plugin/host.ts`.

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
| Provider-neutral long-term memory contribution and isolated SQLite-backed local engine | Built and tested |
| Configurable tool-set contributions and blueprint grants | Ported and tested |
| SearXNG search and Crawl4AI extraction builtin tool set | Ported and tested |
| Message gateway, and the `web` broker over the HTTP surface | Built and tested |
| Artifact pipeline — bidirectional streamed ingestion/output, SHA-256 blob deduplication, conversation-scoped references, deterministic rendition cache, Sharp image processing and authenticated delivery | Built and tested |

Deferred, each with the trigger that un-defers it, in
[NOX.md](NOX.md#v1-scope): extension package loading, richer memory administration, apps and
additional provider/back-end integrations.

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