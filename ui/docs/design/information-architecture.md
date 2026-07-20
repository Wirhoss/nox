# Information architecture

## Domain model

```text
Blueprint ──creates/configures──> Agent
                                    │
Provider/model ─────serves──────────┤
Tools/permissions ──constrain───────┤
                                    ├──participates as Role──> Workspace
Broker ──carries──> Conversation ───┤                         │
                     │              └──owns──> Session         ├──contains──> Task
                     │                           │              ├──produces──> Artifact
                     └───────────────────────────┴──creates────> Run
                                                                  │
                                                                  └──may create──> child Run
```

### Blueprint

A reusable, versionable definition of an agent's default behavior and allowed
capabilities. It contains the system prompt, core and lazy tools, provider,
model, iteration limits, and eventually context/memory policies.

### Agent

A configured runtime identity based on a blueprint. An agent may serve many
conversations, participate in multiple workspaces, and use the same provider as
other agents. Updating a blueprint must not silently mutate a running agent or
historical session; version selection should be explicit.

### Role

A workspace-scoped overlay describing an agent's responsibility, objective,
participation rules, and task. A role may restrict capabilities but must never
grant tools or permissions absent from the agent's blueprint. The same agent
can have different roles in different workspaces.

### Team preset

An optional saved mapping of existing agents to roles and coordination defaults.
It is a creation shortcut, not a separate execution primitive.

### Broker

An ingress/egress adapter such as Web, Discord, WhatsApp, or API. A broker owns
connection health and routing configuration but does not own an agent's
conversation state.

### Conversation and session

A conversation is the human-visible thread across a broker. A session is the
agent context bound to that thread. They are initially close to one-to-one, but
remain separate so group conversations, session replacement, and branching can
be represented later.

### Workspace

A persistent multi-agent activity. Initial specialized modes are:

- **Research:** plan, parallel investigation, evidence checking, synthesis.
- **Deliberation:** proposals, critique, rounds, consensus, minority opinion.

Both use participants, roles, tasks, shared state, runs, budgets, and artifacts.

### Run

One bounded execution in response to a message or task. Runs expose timing,
model/provider, token/context use, tool calls, permissions, errors, and child
runs. A spawned subagent is represented as a child run backed by an existing or
ephemeral agent instance.

### Shared board

Compact structured state shared by collaborating agents: facts, proposals,
agreements, conflicts, evidence, and unanswered questions. Agents receive
relevant board fragments and directed messages instead of the complete group
transcript by default.

### Artifact

A durable output such as a report, decision, source collection, plan, table, or
code patch. Artifacts remain inspectable after a workspace completes.

## Primary navigation

```text
Overview
Operate
  Agents
  Workspaces
  Conversations
Build
  Blueprints
  Providers
Observe
  Runs
  Statistics
  Logs
Playground
Settings
  Brokers
  Tools
```

The visual sidebar should use section labels only when expanded. In compact
mode, icons retain tooltips and active-state labels. Playground is visually
separated because it is a testing surface rather than the workbench's home.

## Route map

| Route | Purpose | Initial availability |
| --- | --- | --- |
| `/` | Operational overview | Partial |
| `/agents` | Runtime agents and health | Future contract |
| `/agents/:id` | Agent activity and configuration | Future contract |
| `/workspaces` | Research and deliberation workspaces | Future contract |
| `/workspaces/new` | Create a research or deliberation workspace | Prototype |
| `/workspaces/:id` | Workspace activity, tasks, artifacts, runs | Future contract |
| `/conversations` | Threads across all brokers | Derived later |
| `/conversations/:id` | Conversation plus technical timeline | Derived later |
| `/blueprints` | Blueprint library | Current API |
| `/blueprints/new` | Blueprint creation | Current API |
| `/blueprints/:id` | Blueprint editor and usage | Current API |
| `/providers` | Provider configuration and health | Current API |
| `/runs` | Searchable execution history | Future contract |
| `/runs/:id` | Run timeline/tree and context accounting | Future contract |
| `/statistics` | Usage, latency, cost, and efficiency | Future contract |
| `/logs` | Structured runtime logs | Future contract |
| `/playground` | Web chat and controlled experiments | Current API |
| `/settings` | Application-wide, broker, and tool configuration | Current API/partial |
| `/settings#brokers` | Installed broker connections and routing | Future extension contract |
| `/settings#tools` | Installed tool inventory and permission policy | Current API/partial |

“Current API” means an endpoint exists, not that every proposed field is
currently exposed.

Brokers and tools are installed capabilities, not workbench-authored objects.
Their implementations come with Nox or an app extension; the UI only configures
instances and policies that an installed implementation exposes. Consequently,
these surfaces never offer “New broker” or “New tool” actions. Extension
installation and management is a separate application-level workflow.

## Global application frame

The frame has three persistent regions:

1. **Sidebar:** product navigation, system identity, and compact local status.
2. **Top bar:** current location, scope/search, alerts, and global run activity.
3. **Content:** one main task with an optional contextual inspector.

The sidebar footer shows daemon health and local/cloud activity. A global run
indicator opens a small activity tray rather than redirecting away from the
current task.

## Primary workflows

### Configure and test a blueprint

```text
Blueprints → New blueprint → Configure behavior/capabilities
           → Validate references → Save → Open in Playground
           → Run test → Inspect context/tools → Revise blueprint
```

The Playground test uses an explicit blueprint version and a disposable or
named session. Unsaved editor changes are never silently used.

### Inspect a problematic external response

```text
Alert/Overview → Conversation → Message → Run
               → Step/tool/provider error → Retry or redirect
```

The user should reach the cause of a failed response in no more than three
navigational transitions.

### Start Deep Research

```text
Workspaces → New → Research → Question/scope
           → Choose existing agents and roles → Budget/depth
           → Review plan → Start → Monitor/intervene → Final artifact
```

The presets `Quick`, `Balanced`, and `Thorough` configure task fan-out,
validation rounds, source targets, and budgets while keeping advanced controls
available.

### Start a deliberation

```text
Workspaces → New → Deliberation → Question
           → Select existing agents → Assign contextual roles
           → Select moderator/protocol/budget → Start
           → Observe agreements/conflicts → Final decision artifact
```

The default protocol uses one moderator, three rounds, a compact shared board,
and consensus with recorded minority disagreement.

### Approve a protected tool call

```text
Global activity/active run → Permission request
                           → Inspect agent, tool, arguments, scope
                           → Allow once / Deny
```

Persistent permission changes belong in blueprint or application settings and
must not be mixed with a one-time run approval.

## Information hierarchy by surface

### Overview answers

- Is Nox healthy and local?
- Which agents and workspaces are active?
- Is anything blocked, waiting for permission, or failing?
- Which brokers are receiving traffic?
- What changed recently?
- How much local/cloud capacity, context, and money are being used?

### Agent detail answers

- What is this agent configured to do?
- Which blueprint version and provider/model does it use?
- Where is it connected and what is it doing now?
- Which conversations, workspaces, and runs belong to it?
- Is its context/memory healthy and efficient?

### Workspace detail answers

- What is the goal and current phase?
- Which existing agents participate, and in which contextual roles?
- What tasks, conflicts, evidence, and artifacts exist?
- How much budget remains?
- Where can the user intervene?

### Run detail answers

- What triggered this work?
- Which agent, model, provider, and tools were involved?
- What happened in order, including child runs?
- What context was delivered, compacted, retrieved, cached, or avoided?
- Why did it stop or fail, and what can be retried safely?

## Naming conventions

- Use **Blueprint**, never “agent template” and never “agent” by itself.
- Use **Agent** for a runtime identity, not a JSON configuration file.
- Use **Workspace** for research/deliberation containers.
- Use **Run** for execution and **Session** for retained agent context.
- Use **Role** only for workspace-scoped responsibility; provider message roles
  (`user`, `assistant`, `tool`) are an implementation detail.
- Present broker types by recognizable names, but label the web interface
  `Web` rather than treating it as privileged.
