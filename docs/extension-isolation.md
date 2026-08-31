# Extension isolation — design notes

Status: design only. Nothing here is implemented.

Nox is planned as a container, and that is the only deployment shape it aims to
support — running it as a CLI or as a subprocess on a host machine is not
something it sets out to do. That helpfully narrows this document: the image is
the design target, so what the image can offer is what the design can rely on,
and nothing here has to also work on a developer's laptop.

This document exists because the remaining work is not "add a boundary" but
"make the contract able to cross one". It records what a boundary would have to
be, what each crossing in `@nox/extension-api` costs, and which decisions are
still open.

Prerequisites already in place, and why they are not enough:
[architecture.md](architecture.md#trust-boundary).

---

## What a boundary has to be

Three mechanisms are usually proposed. Only one of them is a boundary.

**A worker thread is not one.** This was measured, not assumed. A Bun `Worker`
running an extension body was able to `import('node:fs')` and read a file,
`spawnSync` a child process, read the whole of `process.env`, and open a
network connection. A worker isolates a module graph and a crash; it shares the
process, and everything the process can reach it can reach. A "restricted module
graph" does not change that: `node:fs` is one of several ways out, and the
others include `Bun.*`, `process.binding`, and anything reachable from
`globalThis`.

**A separate process is a partial one.** It buys crash isolation, a separate
module graph, and a place where a memory or CPU limit can be applied. On its
own it buys no filesystem or network restriction, because a child process
started by Nox runs as the same OS user with the same access.

**A confined process is the real one.** The confinement has to come from the
operating system, and since the container is the deployment Nox is designed
for, what the image can offer is what the design gets to build on.

Measured in the running image: **Landlock is available at ABI 7**, from the
unprivileged Nox process, under Docker's default seccomp profile, with no
effective capabilities at all (`CapEff` is zero). That is the answer to the
question this section used to leave open, and it is a good one:

- Landlock needs no privileges, so uid 10001 can apply it. Approaches that do
  need privileges — a dedicated uid via `CAP_SETUID`, a sibling container via
  the Docker socket — are unavailable and, in the socket's case, would be
  root-equivalent anyway.
- ABI 4 and later restrict TCP bind and connect, so **filesystem and network
  are both reachable**, which is exactly the pair the declared model is missing.
- A ruleset is inherited and cannot be relaxed, so the natural shape needs no
  helper binary: the child process starts, sets `PR_SET_NO_NEW_PRIVS`, applies
  its own ruleset, and only then imports the extension. Everything after that
  point is confined, including anything the extension imports.

Bun has no Landlock bindings, so the calls go through `bun:ffi`. That is how
the measurement above was taken.

Every table in this section is a row of `scripts/probe-confinement.ts`, which
exists so these claims stay claims rather than becoming folklore — a kernel
upgrade, a new base image or a change to Docker's seccomp profile can each
falsify one of them without touching a line of Nox:

    docker run --rm --entrypoint bun \n      -v "$PWD/scripts:/repo/scripts:ro" -w /app \n      nox:local run /repo/scripts/probe-confinement.ts

The image carries the built runtime and not the repository, so the probes are
mounted in rather than shipped. Each stage runs in its own child process and
measures the unconfined case
before applying anything, because both mechanisms are one-way — a confined
process cannot go back and ask what it used to be able to do. Last run: all
twenty-eight rows held, at Landlock ABI 7, with `CapEff` empty.

Enforcement was measured too, with a real ruleset applied through `bun:ffi`
inside the running image. Writes were handled and allowed only beneath one
directory; TCP connect was handled with no allow rule at all:

| Attempt | Before | After |
|---|---|---|
| Write inside the allowed directory | allowed | allowed |
| Write outside it | allowed | `EACCES` |
| Connect to a listening port | connected | `EACCES` |
| Connect to a port with no listener | `ECONNREFUSED` | `EACCES` |

The last row is the one that settles it. A port nobody listens on answers
`ECONNREFUSED` from the network stack; after the ruleset it answers `EACCES`,
which means the denial arrives before the stack is consulted. (Bun's own
`Bun.connect` reports `ECONNREFUSED` for a Landlock denial, so the errno above
was read from a raw `connect()` rather than from the runtime's error mapping —
worth knowing before anyone debugs this from a stack trace.)

Inheritance was measured as well, because it closes the exact hole the worker
experiment opened. A restricted parent spawned a child that applied no ruleset
of its own; the child could still write inside the allowed directory and was
denied `EACCES` outside it. So the escape route that defeats a worker — spawn a
process and act through it — does not defeat this.

Finally, a ruleset shaped like a real extension's needs, rather than a minimal
one built to prove a point. Reads and executes allowed beneath `/usr`, `/lib`,
`/lib64`, `/bin`, `/etc`, `/app`, `/proc` and `/sys`; read-write on `/dev` and
on one storage directory; nothing else, and in particular nothing under
`DATA_DIR`:

| | |
|---|---|
| `import('zod')`, `import('sharp')` — the second one `dlopen`s a native binary | both work |
| Read its own program, read and write its storage directory | works |
| Read `.secret-key`, `.auth-key`, or the SQLite database | `EACCES` |
| Write anywhere outside its storage directory | `EACCES` |

The runtime survives its own confinement, native modules included. That was the
open question, and the answer is that the allowed set is small and ordinary:
the runtime's own directories, plus wherever the extension is given to keep
things.

### The network half needs a second mechanism

Landlock does not finish the network story, in two ways that were both measured.

Its network rules address **ports, not destinations** — the rule struct carries
a port number and nothing else. "May connect to port 443" is expressible; "may
connect to api.openai.com" is not. For a runtime whose extensions call HTTP
APIs, allowing 443 allows everything and denying it allows nothing.

And its network rules cover **TCP only**. Under a ruleset that denied TCP with
`EACCES`, a UDP packet still went out. DNS alone is a serviceable exfiltration
channel, so this is a hole and not a rough edge.

The answer is to stop trying to express network policy in the kernel, and to
use the kernel only to make bypass impossible. An unprivileged **seccomp**
filter denying `socket()` for `AF_INET` and `AF_INET6` was measured doing
exactly that:

| | Before | After |
|---|---|---|
| TCP socket | opened | `EACCES` |
| UDP socket, v4 and v6 | opened | `EACCES` |
| Unix socket | opened | **opened** |

The filter cuts at the address family rather than the protocol, which is why
one rule closes both: the instruction that denies a TCP socket is the same one
that denies a UDP one, and a raw socket with it. The runtime stays alive and
`AF_UNIX` stays open, which is the point: the extension keeps its channel back
to the host and loses every other way out.

Every table above measures **one** mechanism, to show what each does and does
not buy. An installed extension never runs under one — it runs under both, and
that end state is measured on its own:

| Under Landlock and seccomp together | |
|---|---|
| Connect to a TCP port | `EACCES` |
| Send a UDP packet | `EACCES` |
| Open a UDP socket over IPv6 | `EACCES` |
| Open the channel back to the host | opens |
| Write inside its storage directory | allowed |
| Write anywhere else | `EACCES` |

So the UDP row in the Landlock table is a statement about Landlock, not about
what ships. Nothing is left open there.

So the division of labour is:

- **The kernel makes bypass impossible.** No sockets of any internet family,
  no filesystem outside the allowlist. Neither is negotiable from inside, and
  both survive a spawned child.
- **The host makes policy expressive.** Network reaches the extension as a
  declared host service over the channel it already has, where the policy can
  be what an operator actually wants to read — by host, by method, with
  timeouts — and where it is auditable, which raw sockets never were.

`"network": { "hosts": ["api.openai.com"] }` is then a declaration the host
enforces and the kernel makes unavoidable.

### Where the declaration lives

One manifest, and the ruleset **compiled from it** rather than maintained
beside it. That is the whole shape of the idea: an extension states what it
needs, the statement is readable before the package runs — the inventory
already reports declarations, including for packages that failed to load — and
the same statement is what the kernel is handed.

Two artifacts would drift. This codebase has already paid for that once, in
miniature, with four hand-written copies of the host package list that
disagreed with each other before anybody noticed.

### Remaining questions

The first is what happens where these mechanisms are not available — an older
kernel, or a platform with a stricter seccomp profile of its own. Refusing to
load installed extensions is the honest default; running them unconfined with a
loud warning is the other option, and it should be a deliberate choice rather
than a fallback that happens quietly.

The second is what an extension's filesystem declaration is allowed to name. A
package that only ever touches its own storage needs no declaration at all,
which should be the common case and the default. Anything wider is a request an
operator has to read and agree to, so the vocabulary should stay small — and it
should never be able to name `DATA_DIR`.

**WASM** is genuinely isolated and genuinely a different contract. It is worth
considering as a second, narrower kind of extension rather than as a migration
target for this one.

---

## The crossings

Every item below is a place where the current contract passes a live JavaScript
object by reference, or calls synchronously across what would become the
boundary. Each is listed with what it would have to become.

### Contributions: `configSchema` and `create()`

`ConfigurableContribution` carries a live `z.ZodObject` the host reads
(`configSchema.shape.type.value`), and a synchronous `create(config)` returning
a live broker, provider, memory, or tool set.

Becomes: at activation the extension process sends a **declaration** of its
contributions — point ID, contribution ID, JSON Schema, `instances`, and any
host policy. `create` becomes an async request answered with an opaque handle;
the host wraps the handle in a local object implementing the interface.

Cheaper than it looks. The host already converts every schema to JSON Schema at
each outward edge (`z.toJSONSchema` in config, gateway, and tool rendering), so
the outward format exists. The discriminator check moves from
`shape.type.value` to the schema's `properties.type.const`.

**Half done.** `create` may now return a promise, and `ContributionDeclaration`
— type, JSON Schema, instances, memoised per contribution — is what the schema
catalogue reads instead of converting the Zod object on every request.

Making `create` asynchronous exposed a bug worth recording: `composeWithSecrets`
returned the factory's result from inside its `try` rather than awaiting it, so
a factory that failed asynchronously would have rejected after the guard had
been left, and the caller would have got a bare error with no mention of the
credential that was missing. It awaits inside the guard now, and a test fails if
that is undone.

**Done.** Configuration used to be validated by composing one discriminated
union across every contributed `configSchema`, which required the host to hold
all of their Zod objects at once — the one thing a contribution running
elsewhere cannot hand over. Each entry is now routed by its `type` to the
contribution that declared it, and that contribution validates its own entry
through `validateContribution`, which returns issues as data with their paths
intact. Validation happens where the schema lives, exactly as tool params
already work.

The messages improved rather than degraded, which is worth saying because the
opposite was the risk. A union that failed to match reported that a union
failed to match; routing names the entry, and says which types are registered:

    [main.type] "anthropic" is not registered at nox.providers. One of: openai_completions.
    [main]      Needs a "type" naming what it configures. One of: openai_completions.
    [main.baseUrl] Invalid input: expected string, received undefined

Seeding a single-instance entry asks the contribution too, rather than parsing
its schema directly: whether the bare type is already a complete entry is a
question only the owner can answer, here and behind a boundary alike.

### Tools: `parameters` and `prepare()`

`Tool.parameters` is a live `z.ZodObject`. `prepare(params)` is synchronous and
returns a `ToolExecution` holding functions. `DeferredExecution.run` returns
`{ ack, result: Promise }` — a promise nested inside a returned object.

Becomes: tools are declared as data (name, description, authority, risk, trust,
output capabilities, JSON Schema). `prepare` becomes an async request answered
with an execution *descriptor* — type, title, preview, risk, gate subject — and
a call ID. `run` becomes a second message. The deferred case becomes two
messages against the same call ID: the ack, then the completion.

This was written up as the expensive item on the assumption that `Tool`'s
roughly 130 references in the kernel all had to change. They do not: that is
the blast radius of the *type*, not of the schema. Exactly two places consume
`parameters` as a live Zod object —

- `prepareToolCall` in the contract package, which validates and then calls
  `prepare` in one function, with a single caller in `runner.ts`;
- `toolParametersSchema`, which converts to JSON Schema for the provider, and
  therefore already wants the serialized form.

So the schema does not have to survive the crossing at all. Extensions keep
authoring in Zod; the contract serializes at declaration time, which is what
rendering already does. Validation moves to the side that owns the schema — the
extension — and `prepareToolCall` is already exactly that seam.

What is left is real but ordinary: `prepare` and `run` become asynchronous, and
`ToolExecution` becomes a descriptor plus a call ID rather than an object
holding functions.

**Also settled, by looking rather than by changing anything.** `ToolContext`
already crosses. The three host objects it carries — the artifact reader, the
output publisher, the response attacher — are asynchronous already and exchange
plain data. Its `AbortSignal` never has to cross at all: the extension side
constructs its own, and the host sends an abort message that fires it. The
deferred `{ ack, result }` shape survives too, since a host-side wrapper can
answer with a promise that a second message resolves.

**Done so far.** `prepare` is asynchronous through the whole seam, and
`prepareToolCall` now builds the object the host holds instead of passing the
tool's own object through: `PreparedToolCall` carries the descriptive half as
data — under the same names, so nothing has to be translated when reading
between the tool and the runner — beside a single `run`. Validation stayed on
the contract side, beside the tool that owns the schema. The one call ID is not
there yet; it has no use until there is a transport to address, and adding it
early would be a field nothing reads.

`ToolDeclaration` is the reading half: name, description, authority, risk,
trust, output, and the parameters already converted to JSON Schema. Everything
that only reads a tool now takes one — the token estimator, the renderer, the
provider request — so the host no longer converts a Zod object, which is
exactly what it will not be able to do once that object lives somewhere else.
It is memoised per tool, which it had to be anyway: the previous code rebuilt
the schema on every read, and the token estimator reads every tool in the table
on every estimate. Measured on one schema, two thousand reads went from 14.5 ms
to 0.11 ms.

**A crossing this document had missed.** Providers are extensions, and the host
was handing them live `Tool` objects — Zod and `prepare` included — on every
request. `ChatProvider.getMessageStream` and the `ModelAccess` stream surface
now take `readonly ToolDeclaration[]`, and `Tool` no longer appears anywhere in
the provider contract. A provider never called `prepare` and never read the
schema object; it only ever needed the reading half.

### Providers

Listed late, because it was missed at first: a provider is an extension, and
the host handed it live `Tool` objects on every request. Now it is handed
declarations, and the contract mentions `Tool` nowhere. Nothing else about a
provider blocks a boundary — its messages and events are already data.

**The session table.** It used to hold `Tool` objects — Zod schema and `prepare`
closure — and now holds `BoundTool`: a declaration and one `prepare(rawParams)`.
Those are the two halves a transport carries, and outside a builtin's own tool
set the kernel no longer names `Tool` at all.

Binding also moved to one place. A tool acquires the set it was granted through
at composition time, which is what produces its gate subject; the history tools
used to do it at registration instead, so there were two answers to the same
question. Now the context binds both halves of the table, and the agent binds
its own artifact tools the same way.

### `ToolSet`

`ToolSet` is an abstract class extensions subclass, not an interface, and a
class instance cannot cross a process boundary.

**Done.** The class stays where it is — extensions keep subclassing it, which is
the ergonomic part and costs nothing — but the host no longer reaches through
it. A set now answers two questions: `declarations`, which is data, and
`prepare(name, rawParams)`, which returns a prepared call. Composing the session
table reads the first and binds against the second, so the host never holds a
granted set's tools, schemas or closures.

Binding has one implementation and two ways in, because a tool reaches the table
from two places: `bindSetTool` for a tool granted through a set, and `bindTool`
for one of Nox's own tools that belongs to no configured set — today the two
artifact tools. What remains for a boundary is a `ToolSet` implementation that
answers those two questions over a transport, which is a class the host writes
rather than a change to this contract.

### `BrokerHost`: the callbacks a broker makes into the host

`receive(event)` and `command(invocation)` return a rejection synchronously.
`agentIds()` and `artifactScope(conversationId)` are synchronous reads.

Two different answers, because these are two different things.

**Done.** `receive` and `command` are asynchronous. The rejection is a real
decision the host makes, and a broker that awaits it pays for nothing it did
not already need — the work an event starts was already queued behind that
answer. The gateway still decides synchronously and resolves; the contract is a
promise because a transport that is not in this process has to be able to wait
for one.

`agentIds` and `artifactScope` keep their synchronous signatures, and neither
needs a change. `agentIds` is host state, so a transport reads a replicated
snapshot rather than asking — replicating cheap state beats an RPC for it. And
`artifactScope` turned out to need nothing at all: it is a pure function of the
broker ID and the conversation ID, so the extension side can compute it.

### `Broker.principalGroups(subject)`

Synchronous, on the authorization path, and deliberately asked per call. The
existing contract argues for that explicitly: membership changes while a
session is open, and the answer that matters is the one true at the moment of
the call.

That reasoning survives the boundary and the signature does not, so it is
asynchronous now and authorization awaits it. Replication would be the wrong
answer here for exactly the reason the contract already gives.

It cost less than expected: `AuthorizationProvider.authorize` already returned
`AuthorizationDecision | Promise<AuthorizationDecision>` and its one caller
already awaited it, so only the grant provider changed — the owner provider
decides from the request alone and stays synchronous.

The rule that a failed group lookup contributes nothing rather than throwing had
to be carried across the change: the lookup is awaited *inside* its guard, since
a transport in another process reports failure by rejecting, and a rejection
that escaped would turn "could not read roles" into a thrown authorization
instead of a denial.

`openScheduledConversation()` is asynchronous too, with no argument against it.

### `Memory`: `blocks`, `editor`, `inspector`

Optional live sub-objects whose **presence** is the declaration — the host
checks whether `editor` exists to decide whether the memory can back the
standard tools.

**It already crosses.** Every method on `MemoryEditor`, `MemoryInspector` and
`MemoryBlocks` already returns `MaybePromise` of plain data, and presence
detection survives on the other side: a proxy built from a declaration either
constructs the sub-object or leaves it `undefined`, so `memory.editor ===
undefined` keeps meaning what it means. This was listed as a blocker and is not
one, like `ToolContext` before it.

What the area did have was a real defect, found by looking for the blocker. The
question "can this memory be edited" was answered in two places — the
contribution declares `capabilities.tools`, and the instance either exposes an
`editor` or does not. Blueprints are validated against the declaration, long
before an instance exists, so the two disagreeing produced a blueprint that
passed validation and an agent that then refused to compose. They are now
reconciled at creation, where both halves are in hand for the first time, and
in both directions: an editor nothing declared can never be granted, which
makes it a capability that silently does nothing.

### `SecretHandle`

The host constructs a handle with the real value and passes it into `create`.
Across a boundary the value has to be sent to the extension process, because an
extension configured with an API key needs the key.

Worth stating plainly, because it is a gain and not a loss: the boundary does
not protect a secret from the extension it was configured for, and it does not
have to. It protects it from every *other* extension — which is precisely what
running everything in one process does not do today.

That the value crosses is less alarming than it first sounds, because of who
chose it. An extension never asks for a secret by name. An operator stores one
under a name of their choosing, and points a field of their own configuration
entry at it; the contribution declares a field that *takes* a secret and has no
say in which. Every `reveal()` in the codebase is then an extension putting the
credential it was handed into an outbound request header — there is no
arrangement where it holds a handle and the host makes the call, short of
proxying every request an extension makes.

**One way that rule was not enforced, found by checking it.** A contribution
could put the reference in a schema *default*. Measured end to end before it was
closed: a schema defaulting a field to `{ $secret: 'DISCORD_TOKEN' }` received
the real token from an entry the operator had written as `{ type: 'greedy' }`,
with nothing in the configuration file to show it had happened. Registration now
refuses a contribution whose schema names a secret in any default, at any depth.
The check reads the converted schema rather than the Zod object, so it reads a
declaration that arrived over a boundary just as well.

The enumeration half was already closed: `nox.secret-store` lists every secret
ID, and it is a control-plane service an installed extension cannot hold.

**One trap, measured, for whoever writes the transport.** `SecretHandle`
defines `toJSON()` as `'[redacted]'`, which is what keeps credentials out of
logs. A transport that serialises resolved configuration with `JSON.stringify`
therefore sends this:

    {"apiKey":"[redacted]","baseUrl":"https://x"}

The extension would then authenticate with the literal string `[redacted]`, and
the only symptom would be a 401 from the provider with nothing pointing at the
cause. Handles have to be serialised explicitly — id and value, as their own
message field — never by walking the config with JSON.

---

## The shape of the decision

This was first written as a choice between migrating the whole contract and
forking it — one surface for trusted in-process packages, another for confined
ones. That was a false choice, and naming it properly makes the answer easy.

**One message-shaped contract, two transports.**

The contract becomes message-shaped everywhere: declarations are data, calls
are asynchronous. What differs between a builtin and an installed package is
not the contract but how a call reaches its implementation.

- A **builtin** runs over a direct in-process transport: a function call that
  returns a promise. No serialization, no second process, no IPC.
- An **installed** package runs over a process transport, confined by Landlock
  and seccomp.

This is not a fork. A fork means two contracts; this is one contract with a
pluggable transport, which is an ordinary and well-understood shape.

Forking looks cheaper than it is. Its real cost is not two APIs but **two
host-side paths per contribution point** — one holding a live object, one
holding a proxy — with two sets of tests and bugs that appear in one and not
the other. It also has a worse failure mode than drift: the confined path
becomes second class, everything real uses the trusted one, and the confined
path rots unnoticed.

Migrating everything is cheaper than it looks, for the reason given under
tools: extensions keep authoring in Zod, and the contract serializes at the
declaration boundary. And it buys something a fork cannot — the builtins become
the proof that the message-shaped contract is usable. If writing the web tool
set against it is painful, it will be painful for everyone, and that is found
out here rather than in somebody else's bug report.

---

## Where the crossings stand

| Crossing | State |
|---|---|
| Contributions: `configSchema`, `create()` | Done |
| Tools: `parameters`, `prepare()`, the session table | Done |
| Providers | Done |
| `ToolSet` | Done |
| `BrokerHost`: `receive`, `command` | Done |
| `Broker.principalGroups`, `openScheduledConversation` | Done |
| `ToolContext`, deferred execution, `Memory` | Already crossed; nothing to change |
| `SecretHandle` | Decided: the value crosses, to that extension only |

Three of the nine turned out to need no change at all, which is worth saying
because each was written up as a blocker first and read as one until somebody
looked. The remaining work is not in this list: it is the transport, and the
`ToolSet`, `Broker` and `Memory` implementations that answer over it.

---

## Order of work

1. ~~Prove the mechanism.~~ Done. Landlock and seccomp are both available
   unprivileged in the image, both were measured denying what they should and
   allowing what the runtime needs, and both survive a spawned child. The
   confinement is no longer the uncertain part, and it stays checkable:
   `scripts/probe-confinement.ts` re-measures every claim in this document.
2. ~~Decide migrate-versus-fork.~~ Decided, and it was a false choice: one
   message-shaped contract, two transports. Still open beside it — what an
   installation without Landlock or seccomp does about installed extensions.
3. ~~Convert the crossings.~~ Done, all nine, with the in-process loader still
   behind them, which is why each landed with the suite green.
4. Add the process boundary: a child process, a message channel, and
   implementations of `ToolSet`, `Broker` and `Memory` that answer over it. The
   confinement is two syscalls in that child before it imports anything.
5. Add the filesystem and network declarations to the manifest, compile the
   ruleset from them, and add the host network service the second one is
   enforced through — since Landlock addresses ports rather than destinations
   and leaves UDP untouched.

Third-party **native** dependencies are downstream of all of it: they need an
installer, per-platform binaries, and a place to run them that is not the Nox
process.
