# Brokers

A **broker** is a transport into the message gateway. It delivers what arrived
and renders what it is handed, and knows nothing about agents, sessions or the
transcript.

Two ship in the image: `web` and `discord`.

---

## Capabilities

What a run produces and what a surface shows are different questions, and the
second one belongs to the transport. Every event a session emits is offered to
every broker, and each one declares what it renders through `BrokerCapabilities`:

| Capability | What it turns on |
|---|---|
| `streaming` | The reply as it is being written |
| `permissions` | Gate requests, and their resolutions |
| `reasoning` | What the model thought — settled, and live when `streaming` is on too |
| `toolActivity` | The calls the agent made and what came back |
| `runs` | When a run started, how it ended, and whether it was truncated |
| `retries` | Provider failures being retried rather than reported |
| `contextChanges` | Fold and compaction rewriting the context |
| `contextUsage` | How full the window is |
| `titles` | The name a session gave itself after its first exchange |
| `usage` | Token accounting, per model call and as a run total |
| `commands` | Slash commands and their results |

A broker that declares nothing gets the settled reply and nothing else — which is
what a bot in a channel wants.

---

## Scheduled replies

`Broker.openScheduledConversation?(): string` is optional, and whether a
transport implements it answers one question: **is a channel here a place, or a
conversation?**

| | Channels are… | Scheduled reply goes… |
|---|---|---|
| `discord` | Real places that outlive conversations | Into the named channel |
| `web` | Nox conversations themselves | Into a **new** conversation, beside the one that scheduled it |

A transport that leaves the method out is saying its channels are rooms, and one
more message in a room costs nothing it did not promise. A transport that
implements it is saying the opposite — appending would put an unattended run's
output in the middle of a live conversation, hours later, under a prompt nobody
typed there.

The gateway asks **before opening the session**, because a transport that answers
is claiming the run belongs to a conversation of its own — something the session
must be opened *into*, artifact scope included.

Full behavior, including how the grant is re-validated after the run, is in
[jobs.md](jobs.md#where-a-scheduled-reply-lands).

Two things stay with the gateway rather than the transport, because they are not
rendering questions: what another participant said, and which principal was
allowed to use which authority. Both are about who may see what.

---

## `web`

The builtin `web` broker is Nox's own HTTP surface acting as a transport. It does
not dial out; it is handed connections by the browser, and its ingress rule is
the access token the API already checks.

It is the reserved `web` entry in `brokers.json`. A missing entry is materialized
automatically and can be disabled, but cannot be renamed or deleted through
Settings:

```json
{
  "web": { "type": "web", "agent": "nox" }
}
```

`agent` is optional here. With one available blueprint, Web uses it
automatically. With multiple blueprints and no configured Web agent, every new
conversation must explicitly choose one in the browser — Nox never invents an
alphabetical default. Agent routing belongs to this broker rather than to a
global setting.

The authenticated installation owner receives every registered authority on this
broker. The Gate still evaluates concrete risk and asks for approval where
required; copying an account ID into configuration is neither necessary nor
supported.

**It declares every capability.** Not because it is a chat client, but because it
is a *surface over the runtime*: a tool call, a compaction, or a run cut at
`maxIterations` needs somewhere to go. The client on the other end decides what
it draws; nothing is decided for it upstream.

### Routes

Mounted only when authentication is configured. Every one requires a token:

| Route | What it does |
|---|---|
| `GET /api/chat/stream` | Server-sent events for every conversation, named by event type |
| `GET /api/chat/conversations` | The conversation list |
| `GET /api/chat/conversations/:conversationId/history` | Reconstructs a transcript |
| `GET /api/chat/agents` | Blueprints available to this broker |
| `GET /api/chat/commands` | The dynamic command catalog |
| `POST /api/chat/conversations/:conversationId/messages` | Sends structured `content`; answers `202`, and the reply arrives on the stream |
| `POST /api/chat/conversations/:conversationId/steer` | Steers a run already in flight |
| `POST /api/chat/conversations/:conversationId/commands/:command` | Invokes a slash command |
| `POST /api/chat/conversations/:conversationId/permissions/:requestId` | Answers a pending gate request |

```json
{ "decision": "approve", "scope": "session" }
{ "decision": "deny" }
```

A conversation is named by the client and bound to a session by the runtime on
the first message it carries. **There is no endpoint that creates one**, because
a chat nobody has spoken in is not yet a session. The binding survives a restart,
like any other broker's.

### Reconnecting

A client that drops its stream resumes it. The `GET /api/chat/stream` handler
reads the standard `Last-Event-ID` request header and replays the events that
were emitted after it, so a run that finished while the browser was offline is
not lost.

Reading a transcript back is a separate surface:
`GET /api/chat/conversations/:conversationId/history`.

### Steering and stopping

`POST …/steer` redirects a run already in flight. Steering is transport intent,
not prose for the model to read.

`/stop` is the host safety command rather than a broker route — it reaches a run
through the command surface, which is why it is available from every transport
that declares `commands` rather than needing a route of its own.

---

## `discord`

A bot connection into guild channels and DMs.

```json
{
  "discord": {
    "type": "discord",
    "applicationId": "…",
    "token": { "$secret": "DISCORD_BOT_TOKEN" },
    "guildId": "…",
    "channels": { "…": { "respondTo": ["mention"] } },
    "dms": ["…"],
    "names": ["nox"],
    "verbose": { "reasoning": false, "toolActivity": false, "usage": false }
  }
}
```

| Key | What it is |
|---|---|
| `applicationId` | The application the bot belongs to. Slash commands are published against the application, not the bot user |
| `token` | The bot credential, by `$secret` reference |
| `guildId` | Where slash commands are published. Omitted, they publish globally |
| `channels` | Admitted guild channels, keyed by channel ID |
| `dms` | Who may open a direct message, by user ID |
| `names` | Extra words that count as being addressed. The bot's own username always counts |
| `verbose` | Which optional capabilities the channel actually sees |

**Closed by default.** Empty `channels` means the bot reads no channel at all —
exactly like `grants`.

`channels` and `conversations` are deliberately two records keyed by the same
IDs: on Discord a conversation *is* a channel, so one record says what Nox
listens to and the other says what may be done there.

A DM needs no ingress rule — there is one person in it, everything they say is
addressed to Nox, and the session never becomes shared. Its conversation ID is
the channel ID, which nobody can know in advance, so a `conversations` override
for a DM can only be written after the first one has been opened.

`grants` is empty by default, and a per-conversation override is what makes one
channel a different security boundary from another. That matters more here than
anywhere else: **one bot connection reaches every channel it can see, with a
single issuer.**

### `guildId` and command scope

When `guildId` is present, commands are published to that guild. Without it,
commands are published globally so they can also be available outside one guild,
including supported DM use. Registration scope and propagation timing are
Discord behavior and should be verified against Discord's current documentation
for the deployment.

### Verbosity vs. capability

`runs` is asked for **unconditionally**, whatever `verbose.runs` says. Run
boundaries decide whether the agent is mid-thought, which is what chooses between
speaking *to* it and speaking *over* it. `verbose.runs` decides what the channel
sees; the broker still needs to know.

`reasoning`, `toolActivity` and `usage` follow `verbose` directly.

### Starting up

The first connection is **awaited**. A broker that reported itself started while
it was still failing to log in would leave a Nox believing it is reachable when
it is not.
