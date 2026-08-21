# Nox — Definition

> This document exists to stop the rewrite. It is the answer to "what is Nox",
> so that question never has to be re-derived from scratch again.
> If a decision contradicts this file, change this file deliberately — don't
> start a new `src/`.

---

## One sentence

**Nox is a containerized, multi-agent runtime whose defining property is that a
long-running session stays cheap: its logical request head remains deterministic,
context is reduced before it is ever summarized, anything a program can do is
done by a program instead of a prompt, and every concrete capability enters as a
contribution rather than an import.**

---

## The three laws

These are the whole point. A feature that violates one of them is not a Nox
feature, regardless of how useful it is.

### Law 1 — The request head is stable infrastructure

The beginning of every logical request is system instructions, tool schemas and
settled history. Nox keeps that sequence deterministic and append-stable so a
provider may reuse it. Whether it is cached, where the cache boundary falls and
what a hit is worth belong entirely to the provider.

Consequences that are binding, not aspirational:

- Tool schemas are presented in deterministic, name-sorted order. Map/object
  iteration order is never trusted, and provider adapters preserve that order
  when serializing their request format.
- Messages are immutable snapshots once inserted. Nothing mutates a message
  in place after the fact.
- **New information enters at the suffix.** Anything that varies during a session
  — retrieved memory, tool results, fresh facts — is appended at the end of the
  working set. It never edits the head. This rule is what makes the memory
  system possible at all (see below).
- **The fixed head may only contain what is stable for the whole session.** A
  blueprint's persona and its tool schemas qualify. A recalled fact does not.
- **Two operations may replace active history: `fold` and `compact`. Nothing
  else does.** Not a recall, not a tool result, not a broker, not an extension, not
  the system prompt mid-session. Everything else appends. `Context` has exactly
  one private method that replaces active history and only those two reach it.
- **Prompt caching is provider behavior, not kernel state.** Nox does not declare
  cache boundaries, send cache-control instructions that an API does not support,
  hash an imagined provider prefix or estimate cache invalidation. A provider
  adapter reports actual cache-read usage when its API exposes it; otherwise Nox
  makes no claim about cache hits.

### Law 2 — Fold first. Compaction is the last resort.

Folding is deterministic and reversible-by-replay: mechanical traffic (tool
calls, tool results, retries, noise) is collapsed by rule, and the original is
still in the transcript.

Compaction is model-assisted and **lossy**. It is what you do when folding has
already been applied and the working set is still over budget.

Consequences:

- Every reduction attempt tries deterministic folding to exhaustion first.
- Compaction is an explicit, recorded, budget-triggered event — never a routine
  step in the loop, never a background convenience.
- Both are transcript events, not destructive mutations. The full history
  survives. "Deleted to save space" is never the mechanism.
- **A fold must reduce the active context, and that reduction is measured in
  tokens before it is applied.** A fold that merely breaks even makes the request
  no smaller and is rejected. The placeholder therefore carries only what the
  model cannot reconstruct: what was called, its track ID, and whether it worked.
  Everything else is still in the transcript, searchable and retrievable by
  track ID.

### Law 3 — If it can be deterministic, it must not be a prompt

Asking a model to do what a function can do costs tokens, costs latency, and
produces a worse answer with a confidence interval attached.

Consequences:

- **Prefer tools over skills.** A capability expressed as code that the model
  *calls* beats a capability expressed as instructions the model must *follow*.
- Parsing, formatting, sorting, filtering, arithmetic, validation, routing,
  lookups, and state transitions are code. They do not get prompt paragraphs.
- The model is asked for judgment, language, and synthesis. Not for work.
- Before adding instructions to a prompt, the question is always: can this be a
  tool? If yes, it is a tool.

### Supporting rules

- **History is not context.** The transcript is permanent and complete; the
  working set is bounded and provider-ready. They are different objects.
- **Retrieval is bounded.** A search or recall tool must never quietly undo the
  space that folding and compaction reclaimed.
- **Replay is the source of truth.** A persisted transcript must reconstruct the
  identical active history.
- **The runtime owns memory policy, not the model.**
- **Pressure is measured before the provider rejects the request**, not after.

---

## The kernel and its contributions

Nox is a **kernel** plus **contributions**. This replaces any notion of a linear
stack, because the previous generations kept building the outer layers first.

```
╔══════════════════════════════════════════════════════════════╗
║  KERNEL — owns the laws, imports nothing concrete            ║
║                                                              ║
║   Context engine     transcript · fold · compact · tokens    ║
║                      prefix · pressure · bounded retrieval   ║
║                      append is the only way in               ║
║                                                              ║
║   Contribution model contribution points · services ·           ║
║                      lifecycle · disposal                    ║
╚══════════════════════════════════════════════════════════════╝
                              ▲
        everything concrete contributes through the same shape
                              │
   providers · tool sets · tools · brokers · memory ·
   blueprints · gates · apps · surfaces (HTTP, UI)
```

**The kernel rule:** no file in the kernel may import a concrete provider,
broker, tool, store, or app. If the kernel needs one, it declares an extension
point and something contributes it. This is not a future refactor — it is a
constraint that holds from the first commit, because violating it is exactly how
the last generation died.

**The contribution rule:** builtins are contributions too. `openai` is not
special-cased in a registry; it registers against the provider contribution point
like anything else would. In-repo and third-party contributions differ only in
how they are *loaded*, never in what they *are*.

---

## Extensions: contract now, machinery later

The extension system is first-class. But it is two separable things, and conflating
them is what produced 1,290 lines of kernel with no agent in it.

**The contract — kernel, from day one** (ported, `src/extensions/`):

| Module | What it gives |
|---|---|
| `contribution.ts` | `ContributionPoint<T>`, typed registration, owner-scoped views |
| `extension.ts` | `ExtensionContext`, `defineExtension` |
| `manifest.ts` | Identity plus the `engines.nox` range, checked at startup |
| `service.ts` | `ServiceToken<T>`, host services, no globals |
| `disposable.ts` | Deterministic teardown of everything a contribution owns |
| `identifier.ts` | The one rule an extension, point and service ID all obey |
| `error.ts` | The `ExtensionError` taxonomy the contract can raise |
| `contribution-points/` | What Nox actually accepts. Today: `nox.providers` |

**The machinery — deferred** (~455 lines, stays in `idk_yet/` for now):

| Module | Why it waits |
|---|---|
| `manifest.ts` (the rest of it) | Versioning, `apiVersion` and dependency validation matter when someone else ships an extension. Nobody does yet. The compatibility range came across early — see the port decisions. |
| `host.ts` | Dependency resolution, activation rollback, degraded startup, hot unload — all solve problems that only exist with untrusted, dynamically-loaded extensions. |

**Why this split is safe, stated precisely:** the machinery *wraps* the contract
without changing it. A contribution written today as
`contributions.register(providers, "openai", impl)` reads identically after a
manifest loader is added around it. Deferring the machinery cannot force a
rewrite. Deferring the *contract* would force one immediately — the kernel would
fill with direct imports, which is architecture review finding #7 and the
proximate cause of the last rebuild.

**Un-defer the machinery when:** a contribution needs to load from outside the
repo, or ship on its own version cycle, or fail without taking the process down.

---

## Memory is an extension

No previous generation had one. It stays out of the kernel — it is the most
speculative subsystem in the project, and speculative design in the kernel is
what rule 6 exists to prevent.

Memory is a contribution, like a provider or a broker. This is also the honest
answer to the product vision: a D&D campaign's memory, a council's record of a
debate, and a coding agent's memory are not the same object, and a kernel that
fixed one shape would be fought by every app.

### What the kernel keeps instead: no way in but append

One thing cannot be delegated. Most agent memory systems recall facts and splice
them into the system prompt, changing the beginning of every later request. That
breaks Nox's stability guarantee and may also forfeit whatever reuse a provider
would otherwise perform. A memory extension free to write anywhere could destroy the
property Nox exists for.

**This is answered by structure, not by a guard.** The kernel exposes no API that
edits the request head. `Context` keeps its active history private, hands out
frozen copies, and offers exactly one way to add anything: append. A contribution
cannot splice into the head because there is nothing to call. That is a stronger
guarantee than a gate, and it costs nothing to maintain.

> **An earlier draft of this document specified a "write boundary" here** — a
> kernel-owned ingress with suffix-only writes, per-token budgeting, and required
> provenance. It was cut, not deferred. Suffix-only was already true by
> construction, as above. Provenance had no consumer. And *budgeting ingress* was
> the same category error as `maxMessageTokens`: refusing content at the door
> does not make the context smaller, it makes the content not exist, which
> collides head-on with "the transcript is permanent and complete". A recall that
> arrives too large is pressure, and pressure is what folding and compaction are
> for.
>
> If a future contribution needs its source recorded, that is a
> `messageId → source` table beside the transcript — metadata, never a gate, and
> never rendered into a message.

The one exception, and it is a narrow one: what is **stable for the entire
session** may sit in the prefix — a blueprint's persona and durable instructions,
fixed at session start. Anything that can change mid-session is suffix, without
exception.

### Memory is not compaction

Routinely confused; conflating them produces "memory" that is a summary with a
better name.

| | Compaction | Memory |
|---|---|---|
| Owned by | Kernel | Extension |
| Scope | One session | Across sessions |
| Lifetime | Until the session ends | Durable |
| Created by | Budget pressure | Explicit write |
| Lossy | Yes | No — it stores what it was given |
| Addressable | No | Yes, by name |

### Constraints on any memory extension

Not kernel policy — the standard a memory contribution is judged against, so that
Law 3 is not abandoned the moment memory becomes someone else's problem:

- **Writes are explicit.** A tool call, or a runtime event with a rule behind it.
  "The model decides what is worth remembering" is a last resort, never the
  mechanism.
- **Addressable.** You can name a memory and fetch exactly it. Ranked retrieval
  is the fallback for when the name is unknown — not the primary path.
- **Retrieval starts deterministic**: keyed lookup, then structured query, then
  BM25. Embeddings are a later contribution, not the foundation. Nox is not a
  vector database bolted to a loop.
- **Scopes are the extension's business.** Per-agent, per-blueprint, per-app shared
  memory — a memory extension decides. The kernel neither knows nor cares.

---

## What Nox *is*

- A **containerized runtime** (Docker). A long-lived process you run, not a
  command you invoke per task. **Local-first**, loopback unless explicitly and
  authenticatedly opened.
- **Web UI** as the richest surface — configuration, agent authoring,
  observation, playground.
- **A message gateway with pluggable brokers** — Discord, WhatsApp, others. A
  broker is a transport contribution, never a special case in the core.
- **Many agents, from blueprints.** A blueprint declares its provider and model,
  its tool sets, the specific tools within them, its memory scopes, and its
  gates.
- **Apps** — composed experiences using agents in a shape other than one chat
  loop. A council deliberating; a D&D table where an agent is DM, NPC, or player.
  *Illustrations of the capability, not v1 deliverables.*

## What Nox is *not*

- **Not a CLI agent.** Not the 99%. A running service, not a command that exits.
- **Not a chat-completions wrapper** with a nicer surface.
- **Not "memory" implemented as an ever-growing prompt** — and not memory
  implemented as prompt injection either.
- **Not a vector database bolted to a while-loop.**
- **Not a prompt-engineering product.** Capability lives in tools and the
  runtime, not in longer instruction text.
- **Not benchmark-optimized.** Correct long-session behavior beats a good demo.
- **Not a third-party extension marketplace** — the contribution model is the spine,
  but distribution, isolation and untrusted code are not yet in scope.
- **Not multi-tenant, not hosted SaaS, not a stable public API.** Not yet, and
  not by accident.

---

## v1 scope

**v1 is the kernel. Nothing outside it.**

v1 is done when this is demonstrably true:

> A session can run for hours, across hundreds of turns, and the request sent to
> the provider stays bounded and append-stable without silently losing
> information — and there is a test that proves it.

**Context engine** — the bulk of the work:

- Append-only immutable transcript, complete and searchable.
- Active working set reconstructed by deterministic replay.
- Deterministic folding of mechanical traffic.
- Token budgeting with reserved output headroom; pressure detected before the
  provider rejects.
- Deterministic, append-stable request inputs: fixed instructions, name-sorted
  tool schemas and immutable history.
- Compaction — implemented, tested, and *rarely reached*.
- Bounded BM25 retrieval over full history.
- Replay invariants under test, including malformed and duplicate history.

**Contribution model** ✅ — the contract half of `idk_yet/` is ported to
`src/extensions/`: contribution points, service tokens, disposables, `defineExtension`.
No manifests, no host. `src/application.ts` activates and disposes them.

~~**Write boundary**~~ — cut from the design, not deferred. See "What the kernel
keeps instead: no way in but append".

**Deferred, with the trigger to un-defer:**

| Deferred | Un-defer when |
|---|---|
| Extension machinery (manifest, host) | A contribution must load from outside the repo or fail independently |
| Memory (entirely — it is an extension) | One session runs end-to-end |
| Web UI | There is a session worth watching |
| Message gateway / brokers | A session runs end-to-end locally |
| Agent blueprints | More than one agent config exists in practice |
| Gates / permissions | Tools can do something worth gating |
| Embedding retrieval | Keyed + BM25 recall is demonstrably insufficient |
| Apps (council, D&D) | The kernel and surfaces are stable |
| Multi-provider | One provider works completely |

Nothing on that list is cancelled. Every one of them is *later*.

---

## Rules that prevent rewrite #4

1. **`bun run check` is green on every commit.** Typecheck + tests. The single
   highest-value rule here — the last generation died with 36 tsc errors and 2
   failing tests, at which point "start over" felt cheaper than "fix 36 errors."
   It never gets that far again.
2. **The kernel imports nothing concrete.** Enforced by review, and eventually by
   a test.
3. **Refactor in place.** An architecture review produces edits to existing
   files. It does not produce a new top-level directory.
4. **No new `src/`.** There is one. Old generations live in git history.
5. **Kernel before contributions.** If you are writing a broker and the context
   engine is unfinished, stop.
6. **Infrastructure is earned — mechanism, not contract.** No abstraction before
   its second real consumer. *This does not apply to the contribution contract*,
   which is kernel by definition: a second consumer would arrive too late to add
   it without a rewrite. It applies fully to loaders, resolvers, containers and
   lifecycle machinery.
7. **Vocabulary is fixed** (below). Renaming the same concept every generation is
   a real part of why this feels like repeated work.
8. **Port, don't rewrite.** Good code from a previous generation is moved and
   fixed, not reimagined from a blank file.

---

## Vocabulary — fixed

| Term | Meaning |
|---|---|
| **Transcript** | Append-only, immutable, complete session log. Source of truth. Searchable. |
| **Active context** | The bounded working set actually sent to the provider. Derived from the transcript by replay. |
| **Prefix** | The logically stable head of a request: instructions + name-sorted tool schemas + settled history. It may be cacheable, but caching is provider-owned. |
| **Suffix** | Where new and varying content is appended. The only legal entry point for recalled memory. |
| **Fold** | Deterministic, rule-based collapse of mechanical traffic. Lossless — the original stays in the transcript. |
| **Compaction** | Model-assisted lossy summarization into a handoff. Session-scoped. Last resort. |
| **Pressure** | Measured proximity to the context budget, including reserved output. |
| **Memory** | Durable, addressable, cross-session knowledge with provenance. An extension, not kernel. Not compaction. |
| **Recall** | A bounded read from memory into the suffix. |
| **Contribution point** | A typed slot the kernel declares and contributions fill. |
| **Extension** | A packaged unit of contributions with a lifecycle: identity, a compatibility range, activation and disposal. One extension may fill several contribution points. |
| **Contribution** | Any concrete capability registered against a contribution point. |
| **Service** | A host-owned dependency handed to contributions by token. Never a global. |
| **Provider** | An adapter to a model API. A contribution. |
| **Tool** | A deterministic capability the model can call. |
| **Direct tool** | A tool whose schema is presented directly in a session's fixed request head. |
| **Routed tool** | A granted tool kept in the session's fixed routing catalog and discovered and invoked through the tool router. This describes access, not deferred code loading. |
| **Tool router** | The deterministic `search_tool` / `call_tool` bridge to a session's routed tool catalog. |
| **Tool set** | A named group of tools a blueprint can grant. |
| **Blueprint** | A declarative agent definition: provider + model + tool sets + tools + memory scopes + gates. |
| **Agent** | A live instance of a blueprint. |
| **Session** | One agent's conversation: a transcript plus its active context. |
| **Gate** | A permission decision on a tool call. |
| **Broker** | A transport contribution (Discord, WhatsApp, …) into the message gateway. |
| **App** | A composed experience using agents in a non-chat shape. |

---

## Porting plan

Good code from previous generations is moved and fixed, not rewritten.

**Context engine** — from `ULTRA_OLD_DO_NOT_CHECK/src/agent/context/` (~2,000
lines, tested). One module at a time, each landing with `bun run check` green:

```
1. immutable.ts    message snapshots            (no deps)          ✅
2. errors.ts       recoverable context errors   (no deps)          ✅
3. tokens.ts       conservative estimation      (needs immutable)  ✅
4. transcript.ts   append-only log + BM25       (needs immutable, errors) ✅
5. fold.ts         deterministic folding        (needs transcript) ✅
6. options.ts      validated policy             (no deps)          ✅
7. prompt.ts       the compaction prompt only   (no deps)          ✅
8. compact.ts      compaction + safe ranges     (needs transcript, fold) ✅
9. search.ts       bounded retrieval tool       (needs transcript) ✅
10. context.ts     orchestration                (needs all)        ✅
```

The port also pulled in what the engine actually depends on, which this plan
had not accounted for: `tool/` (tool, error, render and routed-tool search/call — minus gates),
`provider/` (config, error, stream, provider), `utils/bm25.ts`, and `utils/validate.ts`.
`logger/` was **not** ported — it was rewritten, see below.

The engine now lives at `src/agent/context/`, not `src/context/`. It is the
agent's context, and nothing outside the agent constructs one.

**Agent** — from `ULTRA_OLD_DO_NOT_CHECK/src_old/agent/`, a generation this plan
did not know about. `src/agent/` in that tree is a stub: `runner.ts` is an empty
class, `index.ts` is zero bytes. The working code — a 619-line `Runner` with 428
lines of tests — is in **`src_old/agent/`**, and that is what was ported:

```
1. utils/eventLog.ts   append-only log with cursors   (no deps)          ✅
2. events.ts           the AgentEvent taxonomy        (no deps)          ✅
3. runner.ts           the loop, queue and deferreds  (context, provider, tool) ✅
4. transcript.ts sink  one exit for every append      (edit, not a file) ✅
5. sessionStore.ts     rows ↔ messages, queued writes (schema)           ✅
6. session.ts          identity, context, events      (all of the above) ✅
7. agent.ts            prompt, tools, model, sessions (session)          ✅
```

`~150` lines did not come across: the gate and escalation machinery (deferred,
see below) and the runner's own retry loop, which `BaseProvider` now owns.

**The provider is ported.** It came across from `ULTRA_OLD_DO_NOT_CHECK/src/`,
the generation the rest of `provider/` came from. It is the first thing in the
tree that reaches a real model, and it enters as a contribution — a whole one:

```
src/extensions/builtin/openai/
  extension.ts           manifest, activation, registration
  openAICompletions.ts   the adapter itself
```

`src/provider/` therefore holds only the contract — `BaseProvider`,
`ChatProvider`, `ProviderStream`, config and errors. No concrete adapter lives
in it.

**Decisions taken while porting the provider:**

- **`nox.providers` takes `create(config: unknown)`, not
  `create(config: ProviderBaseConfig)`.** The first real consumer settled a
  question the point had guessed at: provider configuration is
  provider-specific — the OpenAI adapter needs a `defaultModel` and a `type`
  discriminator the base config has never heard of. Each contribution validates
  against its own schema, because it is the only thing that knows what a valid
  config for it looks like. This is exactly the correction that waiting for a
  consumer was supposed to catch.
- **The logger is injected, not a module singleton.** The previous generation
  called `createLogger('provider:openai')` at module scope. The adapter now takes
  one and defaults to `silentLogger`, and the builtin extension hands it
  `context.logger`, so every line an adapter writes is attributed to the
  extension that contributed it.
- **Reasoning is never sent back.** This API has no field for it, and replaying
  it as assistant text invites the model to imitate its own scratchpad.
- **A late deferred result cannot be a `tool` message.** Those must sit directly
  after the `tool_calls` turn they answer. A `deferredResult` is surfaced as user
  content correlated by track ID, which keeps the request valid without
  inventing an ordering the API does not have.
- **A fold rides on the assistant turn whose tool traffic it replaced.** Chat
  Completions has no folded turn, and making one its own message breaks role
  alternation.
- **The old test suite was not ported.** 6 tests were read as a checklist and 24
  new ones written against the current contract, per the same rule that governed
  the context engine.
- **A builtin is a package, not a shim.** The adapter and the extension that
  registers it live in one directory under `extensions/builtin/`. An earlier cut
  put the adapter in `provider/providers/` with a twenty-line extension beside
  it, which bought nothing: delete the extension and the concrete adapter is
  still sitting inside the kernel's own tree. A builtin directory is
  package-shaped on purpose — publishing one later is a move, not a rewrite, and
  it is the event that un-defers `manifest.ts` and `host.ts`.
- **Rule 2 is now enforced by a test.** `boundaries.test.ts` fails if anything
  outside `extensions/builtin/` imports from it, or if one builtin imports
  another. "The kernel imports nothing concrete" stopped being a review
  convention the moment there was something concrete to import.

**The process has an entrypoint.** `src/main.ts` is the composition root: it
reads the environment, loads configuration, opens storage, activates the builtin
extensions, resolves a provider from what they contributed, builds an agent and
runs a session on stdin. `index.ts` is the eight lines that call it. It is the
only file allowed to name a builtin, and `boundaries.test.ts` names it.

- **Provider settings come from the environment, not a config section.** An API
  key does not belong in a file on disk, and a second provider is what earns a
  `providers.json`. `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`.
- **`bootstrap()` is separable from the REPL** so the wiring can be tested
  without a terminal or a network. That test is what proves the composition
  composes, which no unit test had ever covered.

**What running it found immediately** — the argument for running things:

> `Session.open` built a `SessionStore`, loaded the transcript through it (which
> seeds the next sequence number), and then handed the constructor a *second,
> empty* store. A resumed session therefore restarted `seq` at zero and every
> insert collided with `UNIQUE(session_id, seq)`. The store reported the failure
> and the conversation carried on exactly as designed — so a resumed session
> looked perfectly healthy while persisting nothing.

It passed all 79 agent tests. The existing reopen test resumed a session, sent
another turn, and asserted what the *provider* received — the in-memory history,
which was correct. Nothing read back from storage after the resume. The fix is
one store per session, created in `open` and handed to the constructor; the
regression test reads the transcript back from a fresh store.

`openAICompletions.ts` was the last port between the tree and the v1 criterion —
a session that runs for hours against a real model. The stack now runs
end-to-end against a stub. **The criterion is still not met:** there is no test
that drives hundreds of turns through folding and compaction under sustained
pressure, and nothing has yet talked to a real model.

**The prefix is an invariant, not a subsystem.** `prompt.ts` holds the compaction
prompt and nothing else; no separate prefix builder is missing. `Agent` fixes the
system prompt, each session resolves and snapshots the tools from the agent's
current direct and routed tool sets when opened or loaded, `Context` keeps that
snapshot ordered and messages immutable, and the runner passes that append-stable
sequence to the provider. The
adapter owns serialization into its API's request format. Prompt caching and cache
metrics remain provider-specific.

**The old tests do not come with the port.** `cache.test.ts`, `context.test.ts`,
`fold.test.ts` and `transcript.test.ts` stay in `ULTRA_OLD_DO_NOT_CHECK/` as
reference only. Porting a test suite ports the previous generation's assumptions
about what correct behavior *was*, including the ones that were wrong — the
folding that cost more tokens than it reclaimed passed every one of those tests.
The context engine's tests are new code, written once the context definition is
finished. The same held for `src_old/agent/runner.test.ts`: 428 lines that
covered the right cases and were still read as a checklist, not copied.

**Contribution contract** — from `idk_yet/plugin/`, now `src/extensions/`:

```
1. disposable.ts     Disposable, DisposableStore       (no deps)          ✅
2. identifier.ts     assertIdentifier, no semver       (no deps)          ✅
3. error.ts          the ExtensionError taxonomy       (no deps)          ✅
4. contribution.ts   points, registry, scoped views    (disposable)       ✅
5. service.ts        tokens, locked collection         (error)            ✅
6. manifest.ts       identity + engines, no deps graph (identifier)       ✅
7. extension.ts      ExtensionContext, defineExtension (manifest)         ✅
8. application.ts    the composition root              (all of the above) ✅
```

`host.ts` stays in `idk_yet/`, deferred as planned. `manifest.ts` came across
partially: the compatibility range only. Versioning, `apiVersion` and the
dependency graph describe how an extension is *distributed*, and nothing is
distributed yet.

**Decisions taken while porting the contract** — same purpose, same rule:

- **The vocabulary is VS Code's, adopted whole: extension / contribution point /
  contribution.** The unit is an *extension*, the slot it fills is a
  *contribution point*, and what fills it is a *contribution*. The earlier
  hybrid — Eclipse's `plugin` and `extension point` beside VS Code's
  `contribution` — was not wrong, but naming the unit `Extension` while the slot
  stayed `ExtensionPoint` would have given two unrelated concepts the same
  prefix, and `extensions/extension-points/` reads as a possessive that inverts
  the real relationship: a point is declared by the kernel and *filled* by an
  extension, never owned by one. Renamed while there were no extensions written
  yet, which is the only moment it is free.

- **A manifest is `{ id, engines: { nox } }`.** No `version` and no
  `apiVersion`: nothing validates or consumes either yet, and a decorative field
  is worse than a missing one. `engines` is different in kind and was pulled
  forward from the deferred machinery on purpose — it is what an extension asserts
  about the runtime it was written for, and adding a *required* field later
  breaks every manifest at once. Against in-repo builtins the check is
  tautological; it earns its place the day a contribution ships separately, and
  by then it is already there.
- **Compatibility is checked for every extension before any of them activates.**
  Incompatibility is knowable up front, and finding out halfway leaves a
  half-built application behind for a reason that was never in doubt.
- **The runtime version is `NOX_VERSION` in `src/version.ts`**, a constant kept
  in sync with `package.json` by a test rather than read from disk, and
  overridable per application so a test can state what it is checking against.
  An invalid runtime version throws at construction: a version that is not a
  version makes every extension look incompatible for a reason nobody would find.
- **`assertIdentifier` throws `TypeError`.** An invalid ID is a mistake at the
  declaration site, not a runtime condition a caller recovers from. It moved to
  `identifier.ts` with the pattern, leaving the semver and dependency schemas
  behind.
- **`activate` returns `void`; resources are owned through
  `context.subscriptions`.** The returned-disposable convention was dropped —
  not for style, for correctness: anything added to `subscriptions` is tracked
  from the moment it is acquired, so an extension that fails halfway through
  activation still releases what it took. A returned disposable is lost in
  exactly that case, and it was a second way to do what `subscriptions` already
  did.
- **`NoxApplication` is a composition root, not an extension host.** It activates in
  registration order, deactivates in reverse, disposes what extensions owned, and
  refuses configuration once started. It does **not** roll back a failed
  activation: a builtin that cannot start is a wiring bug, and recovering from
  one is the deferred machinery. `stop()` still releases whatever activated.
- **`nox.providers` is the only contribution point declared.** Its consumer
  (`Agent`) and its producer (the provider adapter) both exist or are next. A
  `nox.toolSets` point waits for the first concrete tool set — `src/` has none:
  the only `ToolSet` subclasses are the kernel's own bounded retrieval and the
  tool router. A point is one line; declaring an empty slot early is how rule 6
  gets broken by something that looks free.
- **A provider contributes a factory, not an instance.** `BaseProvider` takes
  its config at construction and that config belongs to the `Config` service,
  which may reload. `ProviderContribution` is an object rather than a bare
  function so later fields do not break every registration site.
- **Three service tokens: `nox.config`, `nox.database`, `nox.logger`.** Types
  only, so declaring them keeps the kernel free of concrete imports.

**Debt to fix during the port, not after** — from the previous architecture
review:

- `Context` encapsulation was left half-finished: getters without setters,
  consumers reaching into internals. Finish the public API this time.
- ✅ `Context.compact()` was a no-op with no callers. Wired to real pressure.
- ✅ Trimming was done by character count, not tokens. Never again.
- ✅ No global singletons. Everything is instance-owned and passed in.

**Decisions taken during the port** — recorded so they are not re-litigated:

- **The kernel imports `ChatProvider` and `Tool`/`ToolSet`.** A deliberate,
  eyes-open exception to "the kernel imports nothing concrete": `Tool` and
  `ToolSet` are fixed vocabulary, and `Context` needs a provider to compact.
  Revisit when the contribution contract lands, not before.
- **The logger was rewritten, not ported.** The pino/pino-pretty version emitted
  multi-line records. The replacement is one line per event with newlines
  escaped, and it is injected rather than a module singleton.
- **Validation is zod.** The old `validate.ts` assert helpers are gone.
  `utils/validate.ts` now holds `parseOrThrow`, which collapses a zod issue list
  into a single-line `RangeError` — a config mistake has to read like a sentence.
- **Gates were dropped from `ToolSet`.** Its only tie to the deferred gate
  subsystem. It comes back when gates do.
- **Folding is measured.** See Law 2.
- **`maxMessageTokens` was removed, not ported forward.** It rejected any
  message over a token ceiling, which meant the one case it ever fired on — an
  oversized tool result — lost its content entirely and left the matching tool
  call without a response, producing an *invalid* request while trying to
  prevent a large one. It also contradicted "the transcript is permanent and
  complete": rejecting to save space is deleting to save space. Message size is
  the active context's problem, and pressure, folding and compaction are what
  solve it. `errors.ts` and `MessageTooLargeError` went with it.

**Decisions taken while porting the agent** — same purpose, same rule:

- **One queue, drained at the top of every iteration.** User messages and
  deferred results go on the same queue and enter the context immediately before
  the request. A run ends only when it produced no tool responses *and* the queue
  is empty. That single condition closes the window the old runner left open — a
  result landing after the last request of a run — with no flag, watermark or
  timer to keep in sync.
- **The runner is long-lived, one per session.** It owns the queue, the
  idle/running/stopped state and the deferred registry, because "is it idle" and
  "did something land" have to be answered by the same object or the answer
  races.
- **A deferred tool closes its pair immediately.** The `deferredAck` satisfies
  the tool call, so every request is valid from the first moment; the
  `deferredResult` arrives later as an ordinary append. Compaction and folding
  therefore need to know nothing about work in flight.
- **A result landing while idle starts a run** (`trigger: 'deferredResult'`);
  landing mid-run it just queues; landing after `stop()` it is still recorded in
  the transcript, because dropping it to save the trouble is deleting it.
- **Orphan tracks are left alone.** An ack with no result, found on reopen, is
  not closed with a synthetic failure. The pair is already valid on the wire, and
  inventing a result that never existed is worse than an unanswered ack.
- **Deferred tools get a session-scoped abort signal**, immediate tools the
  run's. `abort()` and `steer()` end the conversation in flight, not the
  background work; only `stop()` cancels that.
- **Compaction fires from the loop, once, before each request.** The policy
  stays in `Context` — `compact()` is already a no-op without pressure — so
  nothing outside decides the threshold, and `addMessage` stays synchronous and
  infallible. An append that could fail because the summarizer was down would
  lose tool results to save tokens.
- **Retries belong to the provider.** The old runner's retry loop was not ported;
  `BaseProvider` already retries and the stream emits `retry`, which the runner
  only re-emits.
- **`maxIterations` defaults to 90**, accepts `'unlimited'` at the caller's risk,
  and hitting the ceiling ends the run with that status **without appending
  anything**. The old runner injected a fake user message saying so; the
  transcript records what happened, not what we wish the model had been told.
- **The transcript sink is the only exit.** `Transcript.append` calls `onAppend`
  once per live append, and the session hangs both persistence and the `message`
  event off it. Folds and compactions are messages the context writes on its own,
  so they reach storage and the log without anyone remembering to forward them —
  the class of bug the old runner needed a dedicated test for. A sink that throws
  is logged and swallowed: appending is the one operation not allowed to fail.
- **A stored row that cannot become a message refuses to open the session.**
  Replaying a damaged transcript is worse than not replaying it.
- **A failed write is logged and surfaced as an `error` event**, and the
  conversation carries on. What is lost is durability, not the conversation, and
  a session that loses it silently is one you find out about on the next open.
- **The agent owns the prompt, the current direct and routed tool sets, and the
  context policy; sessions cannot override them.** A session resolves and snapshots
  their tools when it is opened or loaded and keeps that request head stable for
  its lifetime. Sessions opened from later configurations may differ; that
  deliberately gives up reuse of the previous head without mutating an existing
  conversation. This is a blueprint in everything but name; when blueprints land
  they describe an `Agent`, they do not replace it.
- **Direct versus routed is an agent assignment for a configured tool set.** It is
  not an intrinsic `Tool` or `ToolSet` exposure property. For now a configured set
  is assigned as a whole; its own enabled-tool selection decides what that set
  contains.
- **`call_tool.params` is a JSON string by design.** Small models were empirically
  less consistent when asked to satisfy a dynamic object schema. The router parses
  the string deterministically and then validates the decoded object against the
  selected routed tool's real schema.

**`ULTRA_OLD_DO_NOT_CHECK/` and the rest of `idk_yet/`** — reference only, module
by module, until the port completes. Then they leave the working tree; git
history keeps them.

---

## The spite, restated

Tokens cost money. Tokens cost latency. Tokens dilute attention.

Repeated tokens are an architectural failure disguised as intelligence — and so
is a paragraph of instructions doing the job of a twenty-line function.

**Keep the history. Fold before you summarize. Keep the request head stable.
Recall into the suffix. If a program can do it, don't ask the model.**
