# Context module audit — open items

Scope: `src/agent/context/` only. Line references are from the audit snapshot; they may drift as you edit.

**Already resolved, not listed below:** tool ordering pinned, `Reponse Size` typo, `reasoning` made indexable.

**Accepted trade-offs, not listed below:** fold as a middle-of-prefix edit (cache invalidation is cheaper than carrying full tool-loop payloads); no tests while the architecture is still moving.

---

## Critical

### 1. Compaction prefix grows without bound

`src/agent/context/context.ts:86-88`

```ts
const lastCompactionIndex = Math.max(0, history.findLastIndex((m) => m.role === 'compaction'));
const start = seekSafeCut(history, lastCompactionIndex + this.compactGuardBeginning, +1);
```

`start` is anchored *after* the last compaction, so a compaction message is never itself re-compacted, and neither are the `compactGuardBeginning` messages that follow it. Each compaction advances the protected head by ~`compactGuardBeginning`:

```
[5 msgs][C1][5 msgs][C2][5 msgs][C3]…[tail]
```

`index(C_k) = index(C_{k-1}) + compactGuardBeginning`, so growth is linear in the number of compactions and none of it is ever reclaimable. After 20 compactions that is 20 summaries plus ~100 raw messages permanently pinned. On a small local context window this is the failure mode that ends the session.

**Fix direction:** allow compaction to absorb prior compactions. Either start the window at `lastCompactionIndex` itself (so `C_{k-1}` lands inside `middle` and is replaced by `C_k`), or keep the current guard for the common path and add a separate "merge all compactions" pass that triggers when the compaction count exceeds a threshold. The second is safer — a summary-of-summaries is lossy, so you want it to be a deliberate, rarer event.

Note the replay implication either way: `replacedMessageIds` will then contain compaction IDs, which `applyCompaction` already handles, so no format change is needed.

---

### 2. Search tool is an unbounded re-injection vector

`src/agent/context/tools.ts:26-29`

```ts
limit: z.number().int().positive().default(5),
sizeLimit: z.number().int().min(-1).default(-1),   // -1 = no truncation
```

`limit` has no upper bound and `sizeLimit` defaults to unlimited. A model — especially a small local one biased toward "more context is better" — can call `search_session_history({ query: "the", limit: 500 })` and pull the entire compacted-away transcript back into the active window in a single tool response. That defeats both folding and compaction, and it is under model control rather than harness control.

**Fix direction:**
- `limit: z.number().int().min(1).max(10).default(5)`
- `sizeLimit: z.number().int().min(200).max(4000).default(1000)` — drop `-1` entirely; there is no legitimate reason for the model to request untruncated history.
- Enforce an **aggregate** byte ceiling across the whole result set inside `SessionHistoryToolSet.call`, not just per message. Per-message limits multiply; a total cap is the thing that actually bounds the blast radius.
- Consider returning a trailing note when results were truncated or dropped, so the model can narrow its query instead of retrying wider.

---

### 3. `formatHistoryMessage` inlines raw base64 for tool responses

`src/agent/context/format.ts:17-23`

The `content` branch renders images safely as `[Image: base64 data]` (line 10), but the `toolResponse` branch does:

```ts
+ `\nResponse: ${JSON.stringify(message.response)}`
```

`message.response` is `MessageContent[]`, so any image-returning tool gets its full base64 payload stringified. This hits twice:

- **BM25 pollution** — `searchIndex.ts:30` and `:45` feed this string into the index, so megabytes of base64 become terms.
- **Context explosion** — `tools.ts:41-42` puts this string directly into the model's context whenever that message is a search hit.

**Fix direction:** extract the content-rendering loop from the `content` branch into a helper and reuse it for `message.response`. Same treatment for images, same output shape.

---

### 4. `truncateMessageText` does not bound non-text content

`src/agent/context/truncate.ts:6-22`

`totalTextLength` sums only `part.type === 'text'`, and the loop pushes every non-text part unconditionally:

```ts
if (part.type !== 'text') {
  parts.push(part);
  continue;
}
```

So `sizeLimit` provides no bound at all on a message containing images — `sizeLimit: 100` can still return a multi-megabyte base64 payload. Compounds #3.

**Fix direction:** count non-text parts against the budget using a fixed notional cost, or replace them with a placeholder (`[Image omitted]`) once the budget is exhausted. Given search results are for keyword recovery, dropping images from search results entirely is defensible and simplest.

Minor, same file: the `…` marker is appended after any trailing image parts rather than at the truncation point (line 24).

---

### 5. `foldHistory` throws on a routine history shape

`src/agent/context/history.ts:203-205`

```ts
if (toolCallMessages.size > 0 || toolResponseMessages.size > 0) {
  throw new Error('Remaining tool call or response messages found after folding context. This should not happen.');
}
```

Fold events are only emitted when the loop encounters a *subsequent* assistant message (line 183). There is no flush after the loop. So if the range ends on `assistant → toolCall → toolResponse` with no assistant message after it — the state after every completed tool round — the accumulator is non-empty and this throws. `Context.fold()` (`context.ts:74`) does not catch.

The symmetric case: a range whose `fromMessageId` points at a `toolCall` throws `'No anchor assistant message found'` at line 185, because `anchor` is only ever populated from within the slice, and the anchoring assistant message sits *before* `from`.

**Fix direction:**
- Emit a final fold event after the loop when the accumulator is non-empty, using the same code path as the in-loop emit (factor it into a `flush()` closure).
- Resolve the anchor by scanning backwards from `from` in the full history rather than only within the slice, so partial folds work.
- Keep a real invariant check for the case where no anchor exists anywhere (a range with tool calls before any assistant message is genuinely malformed).

---

## Correctness

### 6. `compact()` has no re-entrancy guard — live/replay divergence

`src/agent/context/context.ts:83-113`

`history` is captured at line 84, awaited at line 96, and `this.messageHistory` is overwritten at line 113.

`addMessage()` during that window happens to survive, because it pushes onto the same array object and the `slice(end)` tail therefore sees it. But `fold()` (line 80) **replaces** `this.messageHistory` with a new array. A fold landing during an in-flight compaction is overwritten by the stale-derived `compactedHistory` — while its `fold` event is already committed to `fullHistory`.

The result is that the live active history no longer matches what `rebuildHistory` produces from the log. Reload the session and you get a different context than the one that was live: a silent prefix change and a guaranteed cache miss on resume. Two concurrent `compact()` calls have the same problem.

This is the only bug found that breaks the event-sourcing invariant, which is the foundation of the whole design.

**Fix direction:** an `isCompacting` flag that makes concurrent `compact()` a no-op, plus a check that `this.messageHistory` is still the array captured at line 84 before committing at line 113 (if not, discard the compaction and let the next cycle retry). Alternatively serialize all mutations through a single queue — worth considering anyway, since `fold`/`compact`/`addMessage` all mutate shared state with no coordination.

**Worth testing once the architecture settles:** for any interleaving of `addMessage`/`fold`/`compact`, `rebuildHistory(getFullHistory())` must deep-equal `getHistory()`. That single property covers this bug and most of the fold edge cases.

---

### 7. Empty compaction output silently destroys context

`src/agent/context/context.ts:101-110`

`assistantMessages.length === 0` is checked, but `flatMap((m) => m.content)` can still produce `[]` — an assistant message with empty content, which small local models emit fairly often on long summarization prompts. The result is a structurally valid `CompactionMessage` with no content replacing N real messages: total, unrecoverable loss from active context.

**Fix direction:** require at least one non-empty text part in the flattened content before committing. On failure, log and return without compacting; the next cycle retries.

Related, same call site (line 95): `middle` is sent as-is with no trailing user turn, and it frequently ends on an assistant message. Several local backends (llama.cpp server, some Ollama templates) will *continue* a trailing assistant turn rather than begin a fresh completion. Appending a synthetic user message ("Produce the handoff now.") makes the compaction call deterministic across backends.

---

### 8. `MessageSearchIndex` aliases the caller's array

`src/agent/context/searchIndex.ts:23-24`, `context.ts:39`

```ts
constructor(messages: Message[] = []) { this.messages = messages; }
```

The array passed as `contextOptions.fullHistory` is stored by reference and mutated by every `append`. Whoever loaded that history from persistence now owns a silently growing array. The `history` getter returns that same live array typed `readonly Message[]` — a compile-time-only guarantee that erases at runtime.

Same pattern in `getHistory()`, `getFullHistory()`, `getTools()` (`context.ts:47-61`): all hand out live mutable internals behind `readonly` types.

**Fix direction:** copy on construction (`[...messages]`), and return copies (or frozen views) from the getters. For `getHistory()` on a hot path, a frozen shallow copy is cheap relative to a provider call.

---

### 9. `Object.freeze` is shallow

`src/agent/context/context.ts:68`, `:103`, `history.ts:187`

`Object.freeze(message)` does not freeze `message.content`. Since BM25 snapshots the *formatted string* at append time, any in-place mutation of `content[i].text` desyncs the index from history permanently, with no way to detect it. For a system whose premise is a stable replayable prefix, deep immutability is worth the cost.

**Fix direction:** a `freezeMessage(message)` helper that freezes the message, its content array, and each content part, used at every construction site.

---

### 10. Fold silently discards orphan tool responses

`src/agent/context/history.ts:129-142`, `:174-179`

`toolResponseMessages` is keyed by `trackId` and rendered only by iterating `toolCallMessages`. A response whose call fell outside the fold range — or a duplicate `trackId` — is pushed to `foldedMessageIds`, so it is removed from active history, but never appears in `renderFold`'s output.

It survives in `fullHistory` and remains searchable, so this is not data loss. But it is an unannounced deletion from active context: the model sees neither the response nor a marker that one existed.

**Fix direction:** after rendering the paired calls, render any remaining unmatched responses as their own lines (`Track Id`, `Was Error`, size). Cheap, and keeps the fold marker an honest account of what was removed.

---

### 11. Duplicate message ID on load is unrecoverable

`src/agent/context/searchIndex.ts:91-96`

`track()` throws on a duplicate `messageId` during construction, so a single bad persisted row makes the entire session unloadable with no repair path.

**Fix direction:** for the constructor path specifically, drop the duplicate and log loudly rather than throwing. Keep the hard throw on `append()`, where a duplicate indicates a live bug rather than corrupted storage.

---

### 12. Fragile BM25 index mapping

`src/agent/context/searchIndex.ts:45-46`

`bm25IndexToMessage.push(...)` assumes `addDocument` always increments `documentCount`. It does today — `src/utils/bm25.ts:103-149` increments unconditionally — so the mapping is currently correct. But the assumption is implicit, and the defensive `throw` at `searchIndex.ts:81` exists precisely because it is not obviously guaranteed.

**Fix direction:** `addDocument` returns the `docIndex`. Use it: `this.bm25IndexToMessage[docIndex] = message`. Makes the invariant explicit and survives any future change to BM25's document handling.

---

### 13. `index.ts` re-exports internals

`src/agent/context/index.ts`

`export *` across every file makes `applyFold`, `applyCompaction`, `isSafeCut`, `truncateMessageText` public API. `applyFold` and `applyCompaction` are replay primitives with strict preconditions; exposing them invites callers to corrupt the log outside `Context`'s coordination.

**Fix direction:** explicit named exports — `Context`, `MessageSearchIndex`, `SessionHistoryToolSet`, the option types, and `formatHistoryMessage`. Keep the rest module-internal.

---

## Token accounting

You mentioned not being sure how to implement this. Concrete sketch below.

The gap today: `compactMinMessages` triggers on message *count*. A single 300KB tool response blows an 8k window while the count sits at 8 — no compaction, no truncation, no warning. And `truncateMessageText` is only wired into search results (`searchIndex.ts:85`); nothing bounds messages *entering* active history.

### Estimation

You do not need a real tokenizer. For budget decisions, a cheap estimator that is stable and slightly pessimistic beats an accurate one that is slow or backend-specific:

```ts
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
```

`3.5` chars/token is conservative for English prose and roughly right for code and JSON, which skew lower (more tokens per char) than prose. Being pessimistic is the correct bias — you compact slightly early rather than overflowing. Images need a flat per-image constant from the model's vision config, or a large fixed number if you do not know.

Two properties matter more than accuracy:

- **Stability.** The same message must always estimate the same. Cache the estimate on the message at construction time (a `WeakMap<Message, number>` keeps `Message` clean, or add a non-serialized field), so a budget check is a sum over cached numbers rather than a re-scan of the whole history. Sum incrementally in `Context` and you get O(1) checks.
- **Consistency with what is actually sent.** Estimate the *serialized* form the provider will send, not the internal shape. If the provider wraps tool calls in JSON envelopes, that overhead is real. A fixed per-message constant (~4 tokens) covers role markers and delimiters well enough.

If you later want precision, the clean seam is a `tokenCounter?: (text: string) => number` on `ContextOptions`, defaulted to the heuristic. A provider that exposes a real tokenizer (llama.cpp `/tokenize`, tiktoken) can inject it without anything else changing.

### Budget model

Add to `ContextOptions`:

```ts
contextWindow?: number;        // total model window
reserveForOutput?: number;     // max generation, held back
compactAtRatio?: number;       // e.g. 0.75 — fraction of usable window that triggers compaction
maxMessageTokens?: number;     // per-message ingress cap
```

Usable budget is `contextWindow - reserveForOutput - systemPromptTokens - toolSchemaTokens`. The last two are computed once and are stable — they are exactly the prefix you are protecting, so it is worth logging them at startup; if tool schemas eat 3k of an 8k window, that is the finding.

### Where it plugs in

**Ingress cap (`addMessage`).** Before appending, if the message exceeds `maxMessageTokens`, truncate it — `truncateMessageText` already does this, it just needs to be called here too. Keep the full version in `fullHistory` and the truncated one in active history. That divergence is the one place where the two histories should legitimately differ, and it needs to be explicit in the replay logic, otherwise it breaks the invariant in #6. The alternative that preserves replay cleanly: store the full message in both, and truncate at *serialization* time only. Simpler, and the serializer is the right place for a budget concern.

**Pressure check.** A `Context.getTokenCount()` returning the running sum of active history. The session loop checks it before each provider call and compacts when `count > usable * compactAtRatio`.

**Compaction trigger.** Replace `compactMinMessages` as the primary gate with the budget check, or keep it as a floor (never compact fewer than N messages, regardless of pressure — compacting 3 messages is pure loss). Both gates together is right: budget says *when*, message count says *whether it is worth it*.

**Fold trigger.** Fold is cheaper than compaction (no model call, deterministic, lossless w.r.t. `fullHistory`). Try folding first when pressure rises, and only compact when folding cannot free enough. That ordering falls out naturally once you can measure how much each would reclaim: `foldHistory` can report the token delta of the events it would emit before you commit them.

### Interaction with cache stability

Budget-triggered compaction fires at unpredictable points, which means unpredictable full-prefix invalidations. Two mitigations:

- **Quantize the trigger.** Compact when crossing the threshold *and* at a safe cut, rather than exactly at the crossing message. `seekSafeCut` already gives you this.
- **Reclaim generously.** Since compaction invalidates everything anyway, compact aggressively when you do it — down to ~40% of usable window rather than just under the threshold. Fewer, larger invalidations beat many small ones. This is the same reasoning behind batching folds.
