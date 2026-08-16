# Nox — Definition

> This document exists to stop the rewrite. It is the answer to "what is Nox",
> so that question never has to be re-derived from scratch again.
> If a decision contradicts this file, change this file deliberately — don't
> start a new `src/`.

---

## One sentence

**Nox is a containerized, multi-agent runtime whose defining property is that a
long-running session stays cheap: the prompt prefix is never invalidated, context
is reduced deterministically before it is ever summarized, anything a program can
do is done by a program instead of a prompt, and every concrete capability enters
as a contribution rather than an import.**

---

## The three laws

These are the whole point. A feature that violates one of them is not a Nox
feature, regardless of how useful it is.

### Law 1 — The prefix is immutable infrastructure

The beginning of every request (system instructions, tool schemas, settled
history) is a cache key. Rewriting it is not a cosmetic change; it is a bill.

Consequences that are binding, not aspirational:

- Tool schemas are serialized in a deterministic, name-sorted order. Map/object
  iteration order is never trusted.
- Messages are immutable snapshots once inserted. Nothing mutates a message
  in place after the fact.
- **New information enters at the suffix.** Anything that varies during a session
  — retrieved memory, tool results, fresh facts — is appended at the end of the
  working set. It never edits the head. This rule is what makes the memory
  system possible at all (see below).
- **The prefix may only contain what is stable for the whole session.** A
  blueprint's persona and its tool schemas qualify. A recalled fact does not.
- Any code path that can alter the prefix must be able to say *why* and *how
  much of the cache it cost*.

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
- **A fold must pay for itself, and it is measured in tokens before it is
  applied.** Folding rewrites settled history, so it invalidates the prefix
  under Law 1 — a fold that merely breaks even spends the cache for nothing.
  The placeholder therefore carries only what the model cannot reconstruct:
  what was called, its track ID, and whether it worked. Everything else is
  still in the transcript, searchable and retrievable by track ID.

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
║                                                              ║
║   Write boundary     suffix-only ingress · budget            ║
║                      accounting · provenance for every       ║
║                      contributed token                       ║
║                                                              ║
║   Contribution model extension points · services ·           ║
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
special-cased in a registry; it registers against the provider extension point
like anything else would. In-repo and third-party contributions differ only in
how they are *loaded*, never in what they *are*.

---

## Plugins: contract now, machinery later

The plugin system is first-class. But it is two separable things, and conflating
them is what produced 1,290 lines of kernel with no agent in it.

**The contract — kernel, from day one** (~255 lines, already written in
`idk_yet/`, ports mostly as-is):

| Module | What it gives |
|---|---|
| `extension.ts` | `ExtensionPoint<T>`, typed registration, owner-scoped views |
| `service.ts` | `ServiceToken<T>`, host services, no globals |
| `plugin.ts` | `PluginContext`, `definePlugin` |
| `disposable.ts` | Deterministic teardown of everything a contribution owns |

**The machinery — deferred** (~455 lines, stays in `idk_yet/` for now):

| Module | Why it waits |
|---|---|
| `manifest.ts` | Semver ranges and dependency validation matter when someone else ships a plugin. Nobody does yet. |
| `host.ts` | Dependency resolution, activation rollback, degraded startup, hot unload — all solve problems that only exist with untrusted, dynamically-loaded plugins. |

**Why this split is safe, stated precisely:** the machinery *wraps* the contract
without changing it. A contribution written today as
`extensions.register(providers, "openai", impl)` reads identically after a
manifest loader is added around it. Deferring the machinery cannot force a
rewrite. Deferring the *contract* would force one immediately — the kernel would
fill with direct imports, which is architecture review finding #7 and the
proximate cause of the last rebuild.

**Un-defer the machinery when:** a contribution needs to load from outside the
repo, or ship on its own version cycle, or fail without taking the process down.

---

## Memory is a plugin

No previous generation had one. It stays out of the kernel — it is the most
speculative subsystem in the project, and speculative design in the kernel is
what rule 6 exists to prevent.

Memory is a contribution, like a provider or a broker. This is also the honest
answer to the product vision: a D&D campaign's memory, a council's record of a
debate, and a coding agent's memory are not the same object, and a kernel that
fixed one shape would be fought by every app.

### What the kernel keeps instead: the write boundary

One thing cannot be delegated. Most agent memory systems recall facts and splice
them into the system prompt — under Law 1 that is the worst possible design,
rewriting the cache key on every turn so each recall re-bills the entire prefix.
A memory plugin free to write anywhere could destroy the property Nox exists for.

So the kernel does not own memory. It owns **the boundary every contribution
writes through**, which it needs anyway for tool results and broker input:

- **Suffix-only ingress.** Contributed content is appended where new content
  always goes. Nothing outside the kernel can edit the prefix.
- **Budgeted.** Every contributed token is counted before it lands. A recall
  cannot undo what folding reclaimed.
- **Provenance required.** Contributed content carries its source. Content
  without one is a rumor.

Memory is then simply the first serious consumer of that boundary — and any
future one is constrained identically, for free.

The one exception, and it is a narrow one: what is **stable for the entire
session** may sit in the prefix — a blueprint's persona and durable instructions,
fixed at session start. Anything that can change mid-session is suffix, without
exception.

### Memory is not compaction

Routinely confused; conflating them produces "memory" that is a summary with a
better name.

| | Compaction | Memory |
|---|---|---|
| Owned by | Kernel | Plugin |
| Scope | One session | Across sessions |
| Lifetime | Until the session ends | Durable |
| Created by | Budget pressure | Explicit write |
| Lossy | Yes | No — it stores what it was given |
| Addressable | No | Yes, by name |

### Constraints on any memory plugin

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
- **Scopes are the plugin's business.** Per-agent, per-blueprint, per-app shared
  memory — a memory plugin decides. The kernel neither knows nor cares.

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
- **Not a third-party plugin marketplace** — the contribution model is the spine,
  but distribution, isolation and untrusted code are not yet in scope.
- **Not multi-tenant, not hosted SaaS, not a stable public API.** Not yet, and
  not by accident.

---

## v1 scope

**v1 is the kernel. Nothing outside it.**

v1 is done when this is demonstrably true:

> A session can run for hours, across hundreds of turns, and the request sent to
> the provider stays bounded, with a stable cached prefix, without silently
> losing information — and there is a test that proves it.

**Context engine** — the bulk of the work:

- Append-only immutable transcript, complete and searchable.
- Active working set reconstructed by deterministic replay.
- Deterministic folding of mechanical traffic.
- Token budgeting with reserved output headroom; pressure detected before the
  provider rejects.
- Cache-stable prefix construction, with an explicit account of what invalidates
  it.
- Compaction — implemented, tested, and *rarely reached*.
- Bounded BM25 retrieval over full history.
- Replay invariants under test, including malformed and duplicate history.

**Contribution model** — port the contract half of `idk_yet/`. Extension points,
service tokens, disposables. No manifests, no host.

**Write boundary** — suffix-only ingress, budget accounting, provenance. Needed
in v1 regardless of memory, because tool results already flow through it.
Retrofitting an ingress point into a finished context engine is exactly the kind
of surgery that has previously turned into a rewrite.

**Deferred, with the trigger to un-defer:**

| Deferred | Un-defer when |
|---|---|
| Plugin machinery (manifest, host) | A contribution must load from outside the repo or fail independently |
| Memory (entirely — it is a plugin) | The write boundary exists and one session runs end-to-end |
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
| **Prefix** | The cache-stable head of a request: instructions + tool schemas + settled history. |
| **Suffix** | Where new and varying content is appended. The only legal entry point for recalled memory. |
| **Fold** | Deterministic, rule-based collapse of mechanical traffic. Lossless — the original stays in the transcript. |
| **Compaction** | Model-assisted lossy summarization into a handoff. Session-scoped. Last resort. |
| **Pressure** | Measured proximity to the context budget, including reserved output. |
| **Memory** | Durable, addressable, cross-session knowledge with provenance. A plugin, not kernel. Not compaction. |
| **Recall** | A bounded read from memory into the suffix. |
| **Write boundary** | The kernel-owned ingress every contribution appends through: suffix-only, budgeted, provenance-carrying. |
| **Extension point** | A typed slot the kernel declares and contributions fill. |
| **Contribution** | Any concrete capability registered against an extension point. |
| **Service** | A host-owned dependency handed to contributions by token. Never a global. |
| **Provider** | An adapter to a model API. A contribution. |
| **Tool** | A deterministic capability the model can call. |
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
had not accounted for: `tool/` (tool, error, render — minus gates), `provider/`
(config, error, stream, provider), `utils/bm25.ts`, and `utils/validate.ts`.
`logger/` was **not** ported — it was rewritten, see below.

**Prefix construction was never written.** Line 7 above used to claim
`prompt.ts` was "cache-stable prefix". It is not, and never was: it holds the
compaction prompt and nothing else. Nothing in any previous generation built a
prefix or accounted for what invalidated it. It is new code, not a port.

**The old tests do not come with the port.** `cache.test.ts`, `context.test.ts`,
`fold.test.ts` and `transcript.test.ts` stay in `ULTRA_OLD_DO_NOT_CHECK/` as
reference only. Porting a test suite ports the previous generation's assumptions
about what correct behavior *was*, including the ones that were wrong — the
folding that cost more tokens than it reclaimed passed every one of those tests.
The context engine's tests are new code, written once the context definition is
finished.

**Contribution contract** — from `idk_yet/plugin/`: `disposable.ts`,
`extension.ts`, `service.ts`, `plugin.ts`. Ports close to as-is; drop the
manifest dependency from `plugin.ts` and keep `assertIdentifier` (currently it
lives in `manifest.ts` — move it, don't drag the schema along).

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

**`ULTRA_OLD_DO_NOT_CHECK/` and the rest of `idk_yet/`** — reference only, module
by module, until the port completes. Then they leave the working tree; git
history keeps them.

---

## The spite, restated

Tokens cost money. Tokens cost latency. Tokens dilute attention.

Repeated tokens are an architectural failure disguised as intelligence — and so
is a paragraph of instructions doing the job of a twenty-line function.

**Keep the history. Fold before you summarize. Never invalidate the prefix.
Recall into the suffix. If a program can do it, don't ask the model.**
