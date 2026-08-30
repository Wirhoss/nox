# Configuration

Configuration files are **durable desired state**, not startup arguments. Most
of it reconciles without restarting the process, and what genuinely cannot says
so instead of pretending.

---

## Environment

The environment decides only *where things live*. Everything else is
configuration. Defined in [`src/config/env.ts`](../src/config/env.ts):

| Variable | Default | What it is |
|---|---|---|
| `CONFIG_DIR` | `/etc/nox/config` | Where the JSON configuration files are read from |
| `DATA_DIR` | `/var/lib/nox` | SQLite database, artifacts, and `.secret-key` |
| `EXTENSIONS_DIR` | `DATA_DIR/extensions` | Locally installed extension packages |
| `UI_DIR` | `/app/ui` | Built web UI assets — the output of `bun run build:ui` |
| `CONFIG_WATCH` | off | `1` or `true` enables debounced filesystem reloads |
| `CONFIG_WATCH_DEBOUNCE_MS` | `250` | Debounce window, between 50 and 60000 |
| `NODE_ENV` | `development` | `development`, `production` or `test` |
| `NOX_SESSION_ID` | — | Resumes that session on start |

The defaults are container paths. For local development, point them somewhere
inside the repo:

```bash
export CONFIG_DIR=./.nox/config
export DATA_DIR=./.nox/data
export UI_DIR=./src/ui/dist
```

---

## The sections

Configuration is split into files, each one a section with its own Zod schema.
`applies` is part of the section's declaration, not a guess made at runtime:

| File | Holds | Applies |
|---|---|---|
| `app.json` | Process and machine settings | **restart** |
| `blueprints.json` | Agents: persona, model, grants | hot |
| `brokers.json` | Transports | hot |
| `memories.json` | Memory instances | hot |
| `providers.json` | Provider instances | hot |
| `toolsets.json` | Tool set instances | hot |

A failed candidate remains saved and visible while its **last valid generation
keeps serving**. Settings offers retry, revert, and an explicit
**Reload mounted config** action — which stays available even when the watcher
is enabled.

HTTP listen address, SQLite structure and path, and artifact storage
construction report `restartRequired` rather than claiming to have changed live.

---

## `app.json`

```json
{
  "api": { "host": "0.0.0.0", "port": 8080 },
  "artifacts": { "maxArtifactBytes": 104857600, "maxStorageBytes": 10737418240 },
  "auth": {
    "accessTtlSeconds": 900,
    "refreshTtlSeconds": 2592000,
    "secureCookies": false
  },
  "database": { "path": "nox.db", "busyTimeoutMs": 5000, "synchronous": "normal" },
  "logLevel": "info",
  "timezone": "UTC",
  "ui": { "locale": "en" }
}
```

| Key | Default | Notes |
|---|---|---|
| `api.host` / `api.port` | `0.0.0.0` / `8080` | Restart to change |
| `artifacts.maxArtifactBytes` | 100 MiB | One upload's ceiling |
| `artifacts.maxStorageBytes` | 10 GiB | All unique originals and renditions. Must be ≥ `maxArtifactBytes` |
| `auth.accessTtlSeconds` | 15 min | Short on purpose; a revoked session is caught by the guard anyway |
| `auth.refreshTtlSeconds` | 30 days | How long a login survives without use |
| `auth.secureCookies` | `false` | Turn on behind TLS. Off by default because an ordinary Nox is `http://localhost:8080`, and a cookie the browser refuses to send is a login that silently never persists |
| `database.synchronous` | `normal` | SQLite durability mode |
| `logLevel` | `info` | Hot |
| `timezone` | `UTC` | IANA zone — see below |
| `ui.locale` | `en` | Interface language. Hot |

### `timezone` is how an agent knows what day it is

Every message a model is shown carries the moment it was said, in the configured
zone:

```text
[from esteban · 2026-08-23 14:14 GMT-6]
```

Nothing injects a live clock into the system prompt. The newest message in the
history **already is** the current time — so the cached prefix of a request never
moves just so the model can read a clock, and a replayed request renders
byte-for-byte as it did the first time. This is Law 1 paying for itself in a
place you would not expect.

---

## Secrets

Credentials never belong inline in ordinary configuration. Nox keeps them as
encrypted records in its database. An authenticated administrative surface can
create, replace and delete values — but **cannot read them back**. Configuration
contains only a reference:

```json
{ "apiKey": { "$secret": "OPENAI_API_KEY" } }
```

The store generates `.secret-key` in `DATA_DIR` with owner-only permissions.

> **Back up that key together with the database.** Losing it makes the encrypted
> values intentionally unrecoverable.

Values reach configured contributions as **redacted snapshot handles**, never as
strings in a config object. Rotating a secret reconciles the replacement
provider, memory, tool-set, agent and broker generations; work already in flight
finishes against its immutable snapshot.

Environment variables and mounted secret directories are **not** alternate
sources. There is one way in, and it is write-only.

```mermaid
flowchart LR
  OP["operator"] -->|"write-only"| ST["SecretStore<br/>encrypted in SQLite"]
  CFG["configuration<br/><code>{ $secret: ID }</code>"] -->|"reference"| ST
  ST -->|"redacted handle"| C["configured contribution"]
  ST -.->|"never"| READ["read back"]
  KEY[".secret-key<br/>in DATA_DIR"] --- ST
```

---

## Reconciliation

A configuration change produces a new *generation* of every component that
depends on it. The old generation keeps serving until the new one activates
successfully.

- A component that fails to build is reported **per component**, not fatally.
- The last working generation stays in service while the failure is corrected.
- A live session's configuration snapshot stays stable: a change that lands
  mid-call takes effect on the next one, not this one.

An agent can administer this same desired state through the `config` tool set —
see [extensions/configuration.md](extensions/configuration.md).
