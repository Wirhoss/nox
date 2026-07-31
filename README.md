<div align="center">

# NOX

### An agent runtime built out of spite.

**Stop Context Explosion. Preserve the prompt cache. Waste fewer tokens.**

Because context windows are not landfills, and tokens are not free.

`TypeScript` · `Bun` · `Elysia` · `Zod` · `BM25`

</div>

---

## Why does this exist?

I built Nox out of spite for the absurd amount of tokens other agents waste.

Too many agent systems treat context like an infinite append-only string: every tool result, every failed command, every stale plan, every repeated explanation—sent back to the model on every turn until the window explodes.

Then they call the result "memory."

Nox takes a different position:

> **History is permanent. Context is a working set. They are not the same thing.**

It is built around two core problems:

### 1. Context Explosion

An agent keeps appending messages, tool output, retries, and stale reasoning until every request is enormous. Nox folds mechanical traffic, compacts semantic state, and keeps the complete transcript searchable instead of shipping all of it on every turn.

### 2. Cache Invalidation

A smaller prompt is not automatically a cheaper prompt. Constantly rewriting its beginning destroys the provider's reusable prefix and forces stable instructions, tool schemas, and old messages to be processed again. Nox keeps the request prefix deterministic, immutable, and name-sorted, and changes active history deliberately rather than casually rebuilding the entire prompt.

The goal is an agent runtime that can work for a long time without repeatedly paying to reread everything it has ever done—or invalidating cache entries that were still useful.

---

## The idea

Nox keeps two views of an agent session:

```text
                         ┌──────────────────────────┐
                         │  Append-only transcript  │
                         │  complete · searchable   │
                         └────────────┬─────────────┘
                                      │ replay
                                      ▼
┌──────────────┐   fold   ┌──────────────────────────┐   compact   ┌──────────────┐
│ Tool traffic │ ───────▶ │  Active working context  │ ─────────▶ │  Handoff     │
│ and results  │          │  bounded · provider-ready│            │  summary     │
└──────────────┘          └────────────┬─────────────┘            └──────────────┘
                                      │
                                      │ bounded retrieval
                                      ▼
                         ┌──────────────────────────┐
                         │  BM25 history search     │
                         │  exact anchors on demand │
                         └──────────────────────────┘
```

The model receives the smallest useful working set. The full session remains available when it actually needs an old fact, identifier, error, path, or tool result.

No ritual rereading. No silent deletion. No pretending a 40,000-token transcript is a memory system.

---

## Design laws

Nox is being built around a few non-negotiable rules:

1. **Context is finite.** Pressure must be measured before the provider rejects the request.
2. **Stable prefixes are infrastructure.** System instructions and tool schemas must not change order accidentally and invalidate the prompt cache.
3. **History is not context.** Old information can remain durable without occupying every prompt.
4. **Compression must be observable.** Folding and compaction are transcript events, not destructive mutations.
5. **Retrieval must be bounded.** A search tool should never undo the space reclaimed by compaction.
6. **Replay is the source of truth.** A persisted transcript must reconstruct the same active history.
7. **Malformed history should be repairable.** Corruption diagnostics are better than making an entire session unloadable.
8. **The model does not own memory policy.** The runtime does.

---

## What exists today

The current foundation includes:

- An append-only, immutable session `Transcript`.
- A separate active history reconstructed through event replay.
- Deterministic folding of tool calls and responses.
- Provider-assisted compaction into state handoffs.
- Context-pressure handling with reserved output budget.
- Stable, name-sorted tool schemas for deterministic prompt prefixes.
- Immutable message snapshots that prevent accidental prefix churn.
- Conservative token estimation for messages and tool schemas.
- Per-message ingress limits with typed recovery errors.
- Bounded BM25 search across the complete transcript.
- Paginated recovery of historical tool results.
- Read-only history-search capabilities exposed to the agent.
- Duplicate persisted-message recovery and load diagnostics.
- OpenAI-compatible streaming provider primitives.
- Tests for replay, pressure, encapsulation, retrieval, and malformed history.

The interesting code currently lives in:

```text
src/agent/context/
├── context.ts       # active context orchestration
├── transcript.ts    # immutable log, BM25 index, bounded retrieval
├── fold.ts          # deterministic tool-traffic folding
├── compact.ts       # compaction replay and safe ranges
├── tokens.ts        # conservative request-size estimation
├── search.ts        # read-only tools exposed to the model
├── options.ts       # validated context policy
├── immutable.ts     # immutable message snapshots
└── errors.ts        # recoverable context errors
```

---

## Status

> [!WARNING]
> **Nox is early and under active construction.** The context engine is the first serious subsystem; session orchestration and the complete runtime are still being wired together.

This is not a polished framework, a stable API, or a production release yet.

The next work includes:

- Integrating context pressure into the session/runner loop.
- Handling oversized tool results out of band.
- Surfacing "still over budget" after compaction.
- Improving image token accounting.
- Measuring long-session transcript and BM25 growth.
- Expanding replay invariants with property-based tests.

That is intentional. The first objective is to make the memory model correct before making the agent look impressive in a demo.

---

## Development

Nox uses [Bun](https://bun.sh/) and TypeScript.

```bash
# Install dependencies
bun install

# Run backend tests
bun test ./src

# Run the context tests only
bun test ./src/agent/context

# Lint
bun run lint
```

The complete application entry point is still being reconstructed, so expect full-project typechecking or startup to expose unfinished integration work while the architecture settles.

---

## What Nox is not

- Not another thin chat-completions wrapper.
- Not "memory" implemented as an ever-growing prompt.
- Not a vector database attached to a loop and called an agent.
- Not optimized for benchmark screenshots at the expense of long-running behavior.
- Not interested in spending your entire context window to remember that it already read a file.

---

## The spite, stated plainly

Tokens cost money.

Tokens consume latency.

Tokens dilute attention.

Repeated tokens are often an architectural failure disguised as intelligence.

A context window should not explode because the runtime cannot distinguish working state from history. A prompt cache should not be invalidated because a map changed iteration order or an internal message was mutated after insertion.

**Nox is my attempt to build the agent runtime I wanted other agents to be: deliberate about context, protective of cache locality, honest about memory, and hostile to waste.**

---

<div align="center">

### Keep the history. Control the context. Preserve the cache. Finish the work.

</div>
