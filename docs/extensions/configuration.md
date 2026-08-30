# The `config` tool set

Lets an agent inspect and administer the same durable desired state Settings
edits. It does **not** write files behind the runtime's back: reads, schemas,
entry CRUD, mounted-file reload, activation retry and failed-change revert all
pass through the shared configuration administration boundary, including
reference policy and generation reconciliation.

---

## Configuring an instance

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

| Key | What it allows |
|---|---|
| `readSections` | Which configuration sections the read tools may inspect |
| `writeSections` | Which sections the mutation tools may change |
| `manageRuntime` | Exposes the reload, retry and failed-change revert tools |
| `readSecretMetadata` | Exposes secret metadata — never values |

Grant the configured instance from a blueprint like any other capability:

```json
{
  "toolSets": { "direct": ["config"], "routed": [] }
}
```

---

## Tools

| | |
|---|---|
| `config_status` | Current activation and failure state |
| `config_schema` | The schema for a section |
| `config_list` | Entries in a section |
| `config_get` | One entry |
| `config_toolsets` | Available tool sets |
| `config_secrets` | Secret IDs and storage state |
| `config_update_app` | Change `app.json` |
| `config_create` | Add an entry |
| `config_replace` | Replace an entry |
| `config_delete` | Remove an entry |
| `config_reload` | Reload mounted files |
| `config_retry` | Retry a failed activation |
| `config_revert` | Revert a failed change |

All of it is subject to the instance policy above, plus ordinary `enabledTools`
and blueprint cuts.

### Authorities

Three, separated so a grant can be partial:

- `nox.toolset.config.read`
- `nox.toolset.config.write`
- `nox.toolset.config.runtime`

Configuration mutations declare privilege and write risk, so the Gate can require
explicit approval. Deletion and runtime recovery also declare their irreversible
effects.

---

## There is no tool that accepts a secret value

`config_secrets` returns IDs, storage state, references and consumers only.

This is deliberate and it is not an oversight to be fixed. Passing a secret as a
model-generated tool argument would put the credential in **provider input, the
transcript, and audit data** — three places it can never be removed from.

An agent may configure a `{ "$secret": "ID" }` reference and report that its value
is missing. The operator supplies or rotates that value through the write-only
Settings surface. See
[../configuration.md](../configuration.md#secrets).

---

## An agent cannot pull the rug out from under itself

The configuration snapshot held by a live session stays stable.

An agent may change its own blueprint, or even remove this grant for future
sessions. The current tool call still finishes against the generation it started
with.
