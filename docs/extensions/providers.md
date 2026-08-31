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

Endpoint and credential fields are absent from the base contract because an
in-process provider does not use them. Retry settings remain in the base because
the provider streaming contract implements retry behavior for both local and
remote adapters.

A provider reached over HTTP adds exactly two things — where it is, and who it
says it is:

| Key | Notes |
|---|---|
| `baseUrl` | Required. The HTTP(S) base URL of the endpoint |
| `apiKey` | Optional `{ "$secret": "ID" }` reference |

`apiKey` is optional so an endpoint that does not require a credential can be
configured without a placeholder secret.

---

## `openai_completions`

The `openai_completions` adapter targets endpoints compatible with the OpenAI
Chat Completions request and streaming formats. Compatibility can vary when an
endpoint implements only part of that API, so deployments should verify the
models and modalities they use. The contribution declares `instances: many`,
allowing several configured endpoint instances.

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

Secret references are resolved by the host when it constructs the configured
provider. Reusing one secret ID across provider entries makes that sharing
explicit in configuration.

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

### Explicit local-model selection

Nox does not create a local-provider entry automatically. Settings can offer the
singleton contribution while leaving it unconfigured. If an entry enables the
embedding or chat slot, its model fields must pass validation before the provider
is activated. This keeps model downloads and local resource use behind an
explicit configuration choice.

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

For an embedding model, `dimensions` is required and declared rather than
discovered because vector storage needs a width when it is initialized. Stored
vectors also need model/version provenance: vectors from incompatible models
should not be mixed in one index even when their dimensions happen to match.

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
