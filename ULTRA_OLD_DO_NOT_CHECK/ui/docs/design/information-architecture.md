# Information architecture

## Domain model

```text
Blueprint ──creates/configures──> Agent
                                    │
Provider/model ─────serves──────────┤
Tools/permissions ──constrain───────┤
                                    ├──participates as Role──> Deep Research
                                    ├──participates as Role──> Deliberation
Broker ──carries──> Conversation ───┤
                     │              └──owns──> Session ──creates──> Run
                                                                  │
                                                                  └──may create──> child Run
```

### Blueprint

A reusable, versionable definition of an agent's default behavior and allowed
capabilities. It contains the system prompt, core and lazy tools, provider,
model, iteration limits, and eventually context/memory policies.

### Agent

A configured runtime identity based on a blueprint. An agent may serve many
conversations, participate in multiple research or deliberation activities, and use the same provider as
other agents. Updating a blueprint must not silently mutate a running agent or
historical session; version selection should be explicit.

### Role

An activity-scoped overlay describing an agent's responsibility, objective,
participation rules, and task. A role may restrict capabilities but must never
grant tools or permissions absent from the agent's blueprint. The same agent
can have different roles in different research or deliberation activities.

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

### Deep Research

A persistent investigation with its own objective, research team, evidence,
tasks, depth and budget policy, runs, and final report.

### Deliberation

A persistent decision process with its own question, participants, contextual
roles, protocol, rounds, agreements, conflicts, runs, and decision artifact.

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
code patch. Artifacts remain inspectable after an activity completes.

## Primary navigation

```text
Overview
Operate
  Playground
  Deep Research
  Deliberation
Build
  Blueprints
  Providers
Observe
  Sessions
  Statistics
  Logs
Settings
  Brokers
  Tools
```

The visual sidebar should use section labels only when expanded. In compact
mode, icons retain tooltips and active-state labels.

## Route map

| Route | Purpose | Initial availability |
| --- | --- | --- |
| `/` | Operational overview | Partial |
| `/deep-research` | Research activities and reports | Current API/partial |
| `/deep-research/new` | Start a Deep Research activity | Current API/partial |
| `/deliberation` | Structured group decisions | Current |
| `/deliberation/new` | Configure a Deliberation | Current |
| `/deliberation/detail?id=:id` | Run and inspect a Deliberation | Current |
| `/blueprints` | Blueprint library | Current API |
| `/blueprints/new` | Blueprint creation | Current API |
| `/blueprints/:id` | Blueprint editor and usage | Current API |
| `/providers` | Provider configuration and health | Current API |
| `/sessions` | Searchable conversation history and session-level observability | Current API |
| `/sessions?session=:id` | Session timeline with nested run/tool inspection | Current API |
| `/runs` | Legacy redirect to session observability | Compatibility route |
| `/statistics` | Usage, latency, cost, and efficiency | Future contract |
| `/logs` | Structured runtime logs | Current API/partial |
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
Deep Research → New → Question/scope → Research team and roles
              → Budget/depth → Review plan → Start
              → Monitor/intervene → Final report
```

The presets `Quick`, `Balanced`, and `Thorough` configure task fan-out,
validation rounds, source targets, and budgets while keeping advanced controls
available.

### Start a deliberation

```text
Deliberation → New → Question → Participant blueprints
             → Moderator/rounds → Create → Start
             → Observe proposals/critiques → Final synthesis
```

The initial protocol uses one moderator and two sequential rounds by default.
Round one gathers independent proposals; later rounds expose the accumulated
record for critique and revision. The moderator then records recommendation,
agreements, remaining disagreement, risks, confidence, and next actions.

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
- Which research and deliberation activities are active?
- Is anything blocked, waiting for permission, or failing?
- Which brokers are receiving traffic?
- What changed recently?
- How much local/cloud capacity, context, and money are being used?

### Agent detail answers

- What is this agent configured to do?
- Which blueprint version and provider/model does it use?
- Where is it connected and what is it doing now?
- Which conversations, collaborative activities, and runs belong to it?
- Is its context/memory healthy and efficient?

### Deep Research detail answers

- What is the objective and current research phase?
- Which researchers participate, and in which contextual roles?
- What tasks, evidence, conflicts, and reports exist?
- How much budget remains?
- Where can the user intervene?

### Deliberation detail answers

- What decision question and round are active?
- Who moderates, proposes, critiques, and supplies evidence?
- What agreements, conflicts, minority positions, and artifacts exist?
- How much budget remains, and where can the user intervene?

### Run detail answers

- What triggered this work?
- Which agent, model, provider, and tools were involved?
- What happened in order, including child runs?
- What context was delivered, compacted, retrieved, cached, or avoided?
- Why did it stop or fail, and what can be retried safely?

## Naming conventions

- Use **Blueprint**, never “agent template” and never “agent” by itself.
- Use **Agent** for a runtime identity, not a JSON configuration file.
- Use **Deep Research** and **Deliberation** as distinct resources.
- Use **Run** for execution and **Session** for retained agent context.
- Use **Role** only for activity-scoped responsibility; provider message roles
  (`user`, `assistant`, `tool`) are an implementation detail.
- Present broker types by recognizable names, but label the web interface
  `Web` rather than treating it as privileged.
