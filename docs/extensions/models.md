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

An entry that names only a `model` stays on the agent's provider — the usual
case is a cheaper model on the endpoint that is already configured.

| Task | What it does |
|---|---|
| `compaction` | Rewrites the working set when folding was not enough |
| `title` | Names a session after its first completed run |

---

## Titling happens out of turn

A session is named once, after its first completed run, and deliberately **off
the critical path**: the reply is already delivered when the request goes out.

A titling call that is slow, or that fails outright, leaves the session with the
ID it already had. Nobody waits for a name.

A session opened with a title given to it is never renamed.

---

## Why this is a separate setting

Compaction and titling are the two places where Nox spends a model on its own
behalf. Making them configurable separately is what keeps Law 3 honest at the
budget level: the work still has to happen, but it does not have to happen on a
frontier model just because the conversation does.

See also [providers.md](providers.md) for how models are declared, and
[../context-engine.md](../context-engine.md#compaction) for when compaction runs
at all.
