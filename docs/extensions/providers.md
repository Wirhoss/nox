# Providers

A provider is an adapter between Nox's message vocabulary and one model
endpoint. Two ship in the image: an OpenAI Chat Completions adapter, and a
local in-process engine.

---

## What every provider has

Defined in
[`packages/extension-api/src/providers.ts`](../../packages/extension-api/src/providers.ts):

| Key | Default | Notes |
|---|---|---|
| `modelConfigs` | — | Every model this instance serves, of whatever kind |
| `maxRetries` | `2` | |
| `retryDelayMs` | `500` | |
| `maxRetryDelayMs` | `30000` | |
| `timeoutMs` | — | |

An endpoint and a credential are **deliberately absent from the base**. They
belong to a provider reached over the network; one running inside this process
has neither, and requiring them would force a local model to invent a URL it
never calls. Retry settings stay in the base, because retrying is the streaming
contract's concern, not HTTP's.

A provider reached over HTTP adds exactly two things — where it is, and who it
says it is:

| Key | Notes |
|---|---|
| `baseUrl` | Required. The HTTP(S) base URL of the endpoint |
| `apiKey` | Optional `{ "$secret": "ID" }` reference |

`apiKey` is optional because `baseUrl` is free: a private-network endpoint
commonly wants no credential at all, and requiring one would make every such
deployment look permanently misconfigured.

---

## `openai_completions`

Anything that speaks the OpenAI Chat Completions API works — point `baseUrl` at
it. This contribution declares `instances: many`, because an instance here is
the address of an independent remote service, and a deployment may genuinely
want several.

```json
{
  "big": {
    "type": "openai_completions",
    "baseUrl": "https://api.example.com/v1",
    "apiKey": { "$secret": "OPENAI_API_KEY" },
    "defaultModel": "qwen38-27b",
    "modelConfigs": [
      {
        "modelId": "qwen38-27b",
        "contextWindow": 131072,
        "inputModalities": ["text", "image"],
        "outputModalities": ["text"]
      }
    ]
  }
}
```

The adapter hands its schema to the host rather than parsing config privately —
so `providers.json` is validated against exactly what the adapter accepts. An
extension that validated its own config would leave the file unvalidatable by
anything but itself.

The credential is handed over for the same reason. `OPENAI_API_KEY` is a shared
name, so every adapter speaking to the same vendor merges into one credential an
operator fills once.

**Modality support:** this adapter encodes text and images. It does not silently
discard declared audio, video or document input — it rejects what it cannot
encode.

---

## `local`

An in-process engine that loads weights directly, with a worker and its own
model host. It serves chat and embedding models.

```json
{
  "local": {
    "type": "local",
    "cacheDirectory": "/var/lib/nox/models",
    "embedding": { "enabled": true, "model": "all-MiniLM-L6-v2", "dimensions": 384 },
    "llm": { "enabled": true, "model": "…" }
  }
}
```

`cacheDirectory` is where downloaded weights live; omitted, they land under the
data directory.

### It refuses to configure itself

A single-instance contribution whose schema is satisfied by its `type` alone
gets seeded into the config file on every boot — and Settings only offers what is
*not* configured. An engine that accepted an empty entry would write itself in,
disappear from the list of things you can add, and commit an installation that
never wanted a local model to carrying one.

So an entry that enables a slot without naming a model is a validation error.
Nothing is loaded until a model is named: an entry naming none is not a
configuration of this engine, it is the absence of one.

---

## Models

### Kinds

A model declares what it is *for*, rather than having it implied by which list it
was declared in — because one endpoint commonly serves several kinds. The same
key and host answer chat and embeddings, and splitting the declaration would turn
one configured service into two instances that can disagree about everything
else.

```json
{ "modelId": "qwen38-27b", "kind": "chat", "contextWindow": 131072 }
{ "modelId": "all-MiniLM-L6-v2", "kind": "embedding", "dimensions": 384 }
```

`kind` defaults to `chat`, and the union is plain rather than discriminated, so a
model declared before kinds existed still parses.

For an embedding model, `dimensions` is **required** and declared rather than
discovered: whatever holds the vectors must allocate for them before it has seen
one. It is also half the identity a stored vector belongs to — re-embedding the
same text with a different model produces a vector that is silently meaningless
next to the old ones. Nothing fails; retrieval just quietly stops being about
anything.

`maxInputTokens` is optional and says where the provider's line is. Splitting
longer input is the caller's job.

### Modalities are explicit metadata

A model is text-only until its exact configuration declares otherwise. **Model
IDs are never used as a capability database.**

```json
{
  "modelId": "vision-model",
  "contextWindow": 131072,
  "inputModalities": ["text", "image"],
  "outputModalities": ["text"]
}
```

Input and output capabilities are independent: a vision model can accept `image`
while producing only `text`. Both lists must include `text` — the chat model
interface requires it — and the content envelope itself supports `text`, `image`,
`audio`, `video` and `document`.

A provider adapter must encode every modality it declares and reject the others
explicitly.

---

## Context window

`contextWindow` is what makes compaction possible at all. An agent takes its
window from the model unless its own policy sets one, and without a window there
is no pressure signal — so `compact()` becomes a no-op rather than guessing. See
[../context-engine.md](../context-engine.md#no-budget-no-compaction).
