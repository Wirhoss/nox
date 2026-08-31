# Extension isolation — design notes

Status: design only. Nothing here is implemented.

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
operating system: a dedicated uid, Landlock, seccomp, or a sibling container.
This is the only shape in which the filesystem and network halves of a declared
permission model can be enforced rather than documented.

Open question, and the one to answer first: what confinement is actually
available where Nox ships. The image runs as uid 10001, non-root, and Bun has
no permission flags of its own. Landlock is unprivileged on Linux 5.13+, which
would suit a non-root parent confining its own children, but this has not been
verified inside the image.

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

### Tools: `parameters` and `prepare()`

This is the crux, and the most expensive item on the list.

`Tool.parameters` is a live `z.ZodObject`. `prepare(params)` is synchronous and
returns a `ToolExecution` holding functions. `DeferredExecution.run` returns
`{ ack, result: Promise }` — a promise nested inside a returned object.

Becomes: tools are declared as data (name, description, authority, risk, trust,
output capabilities, JSON Schema). `prepare` becomes an async request answered
with an execution *descriptor* — type, title, preview, risk, gate subject — and
a call ID. `run` becomes a second message. The deferred case becomes two
messages against the same call ID: the ack, then the completion.

The cost is on the host side. `Tool` has roughly 130 call sites in the kernel,
and they expect a live object whose `parameters` is a Zod schema. Either the
host reconstructs a Zod schema from JSON Schema — lossy, and a source of
disagreement about what validated — or the kernel's `Tool` stops carrying a
schema and carries a validation function instead. The second is the honest one
and the larger change.

### `ToolSet`

`ToolSet` is an abstract class extensions subclass, not an interface. A class
instance cannot cross a process boundary.

Becomes: the extension declares its tools; the host constructs the `ToolSet`
locally and forwards calls. Extensions stop extending `ToolSet`.

### `BrokerHost`: the callbacks a broker makes into the host

`receive(event)` and `command(invocation)` return a rejection synchronously.
`agentIds()` and `artifactScope(conversationId)` are synchronous reads.

Two different answers, because these are two different things.

`receive` and `command` become async. The rejection is a real decision the host
makes; a broker that has to await it is only paying for what it always needed.

`agentIds` and `artifactScope` are host state, not host decisions, and should
be **replicated rather than called**. The host pushes a snapshot into the
extension process at activation and on change, and the broker reads it locally
— which keeps their synchronous signatures intact. This is worth applying
wherever it fits: replicating cheap state is better than an RPC for it.

### `Broker.principalGroups(subject)`

Synchronous, on the authorization path, and deliberately asked per call. The
existing contract argues for that explicitly: membership changes while a
session is open, and the answer that matters is the one true at the moment of
the call.

That reasoning survives the boundary and the signature does not. This one has
to become async, and authorization has to await it. Replication is the wrong
answer here for exactly the reason the current comment gives.

`openScheduledConversation()` is synchronous and returns an ID; it becomes
async with no argument against it.

### `Memory`: `blocks`, `editor`, `inspector`

Optional live sub-objects whose **presence** is the declaration — the host
checks whether `editor` exists to decide whether the memory can back the
standard tools.

Becomes: presence is declared in the activation manifest. The pattern already
exists — `MemoryCapabilities` on the memory contribution carries `tools?: true`
— and this extends it rather than inventing anything. The methods become async
messages.

### `SecretHandle`

The host constructs a handle with the real value and passes it into `create`.
Across a boundary the value has to be sent to the extension process, because an
extension configured with an API key needs the key.

Worth stating plainly, because it is a gain and not a loss: the boundary does
not protect a secret from the extension it was configured for, and it does not
have to. It protects it from every *other* extension — which is precisely what
running everything in one process does not do today.

---

## The shape of the decision

The contract changes above are breaking, and there are two ways to pay for
them.

**Migrate the whole contract.** One contract, everything message-shaped,
builtins included. Simpler to reason about and to keep honest, at the cost of
rewriting every builtin against a less ergonomic surface — and builtins are the
packages that least need isolating.

**Fork the contract.** Trusted in-process extensions keep today's surface;
confined out-of-process extensions get the message-shaped one. The breaking
change lands only where the isolation is actually wanted. The cost is two
contracts to maintain and two sets of semantics to keep from drifting, which is
the failure this codebase has already been bitten by once, in a smaller way,
with the host-package lists.

This is undecided and should be decided before any bridge code is written.

---

## Order of work

1. Answer the confinement question: what the image can actually enforce for a
   child process it starts as a non-root user.
2. Decide migrate-versus-fork.
3. Convert the crossings above in the contract, with the current in-process
   loader still behind them, so each conversion is verifiable on its own.
4. Add the process boundary, which by then is a transport rather than a
   redesign.
5. Extend the declared model to filesystem and network, which only becomes
   enforceable at step 4.

Third-party **native** dependencies are downstream of all of it: they need an
installer, per-platform binaries, and a place to run them that is not the Nox
process.
