# Models for internal tasks

An agent answers people on the `provider`/`model` its blueprint names. But Nox
also talks to itself: it **compacts** the working set when context comes under
pressure, and it **names** a session after its first exchange so a list of
conversations reads as something other than IDs.

Neither is the agent answering anybody, so neither has to run on the agent's
model.

---

## Configuration

In a blueprint:

```json
{
  "taskModels": {
    "compaction": { "model": "qwen38-27b", "provider": "big" },
    "title": { "model": "qwen38-4b" }
  }
}
```

Both entries are optional. Every absent one falls back to the agent's own
provider and model.

An entry that names only a `model` stays on the agent's provider. This allows a
different model on an already configured endpoint without requiring another
provider instance.

| Task | What it does |
|---|---|
| `compaction` | Rewrites the working set when folding was not enough |
| `title` | Names a session after its first completed run |

---

## Titling happens out of turn

A session is named once, after its first completed run, and deliberately **off
the critical path**: the reply is already delivered when the request goes out.

A titling call that is slow or fails leaves the session with its existing ID.
The conversational reply does not wait for the title request.

A session opened with a title given to it is never renamed.

---

## Why this is a separate setting

Compaction and titling are the current model-assisted internal tasks. Separate
configuration lets an operator choose their providers and models independently
from the conversational model. Nox does not claim that one choice is always less
expensive or better; that depends on the available models and workload.

See also [providers.md](providers.md) for how models are declared, and
[../context-engine.md](../context-engine.md#compaction) for when compaction runs
at all.
