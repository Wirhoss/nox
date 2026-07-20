# Low-fidelity wireframes

These wireframes validate information hierarchy, not final component styling.
Desktop is the first target. Narrow screens preserve inspection and emergency
actions but are not intended to reproduce the full three-column workbench.

## Shared shell

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ NOX / Overview                  Search ⌘K      2 active runs     Local ●     │
├───────────────┬─────────────────────────────────────────────────────────────┤
│ OVERVIEW      │                                                             │
│               │                                                             │
│ OPERATE       │                       PAGE CONTENT                          │
│ Agents        │                                                             │
│ Deep Research │                                                             │
│ Deliberation  │                                                             │
│ Conversations │                                                             │
│               │                                                             │
│ BUILD         │                                                             │
│ Blueprints    │                                                             │
│ Providers     │                                                             │
│               │                                                             │
│ OBSERVE       │                                                             │
│ Sessions      │                                                             │
│ Statistics    │                                                             │
│ Logs          │                                                             │
│               │                                                             │
│ Playground    │                                                             │
│ Settings      │ Brokers and tools are configured here                      │
│               │                                                             │
│ Daemon      ● │                                                             │
└───────────────┴─────────────────────────────────────────────────────────────┘
```

The top bar is quiet until action is needed. Active runs and permission requests
open a tray. Search becomes a command palette for navigation, agents, sessions,
collaborative activities, and actions.

## Settings: brokers and tools

Brokers and tools are runtime capabilities supplied by Nox or app extensions.
They are configured here, never created from the UI.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ Settings                                                                    │
├───────────────────┬─────────────────────────────────────────────────────────┤
│ APPLICATION       │ Brokers                                  1 available    │
│                   │                                                         │
│ ⇄ Brokers         │ ◇ Broker types are supplied by extensions              │
│   Connections     │                                                         │
│                   │ Web        Built-in · Playground          ● Available   │
│ ⌘ Tools           │ No broker settings exposed                            │
│   Permissions     ├─────────────────────────────────────────────────────────┤
│                   │ Tools                                   2 registered    │
│                   │                                                         │
│                   │ Registered tool sets                                   │
│                   │ Shell       Installed                    ● Available    │
│                   │ Search      Installed                    ● Available    │
│                   │                                                         │
│                   │ Global permission policies               Add policy    │
│                   │ Tool calls       Action       Reason                    │
│                   │ shell            Ask approval Protected command        │
│                   │                                  Save tool settings     │
└───────────────────┴─────────────────────────────────────────────────────────┘
```

The inventory is read-only because code availability is owned by the runtime
and extension system. Configuration controls are rendered only for settings
that the installed capability can persist.

## Overview

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ Overview                                      Last 24 hours ▾   New…        │
├─────────────────────────────────────────────────────────────────────────────┤
│ System                                                                    │
│ ● Healthy     4 agents     2 active runs     3 brokers     1 needs approval│
├───────────────────────────────┬─────────────────────────────────────────────┤
│ Active now                    │ Resource use                                │
│                               │                                             │
│ Research: Local RAG options   │ Context       184k  ▃▆▂▇▄                   │
│ 4/7 tasks · 61% · 3 agents    │ Avoided       392k  +68%                    │
│ [Open activity]               │ Local runs      86%                         │
│                               │ Cloud cost    $0.24                          │
│ Discord assistant             │                                             │
│ responding · 00:12 · local    │ [View statistics]                           │
├───────────────────────────────┼─────────────────────────────────────────────┤
│ Attention                     │ Recent activity                             │
│                               │                                             │
│ ! Shell permission requested  │ 14:32  Discord → Atlas → Qwen      1.8 s    │
│   Atlas · research task       │ 14:31  Context compacted           8→3 KB   │
│                               │ 14:29  WhatsApp broker reconnected          │
│ ! WhatsApp reconnecting       │ 14:22  Blueprint “critic” updated           │
└───────────────────────────────┴─────────────────────────────────────────────┘
```

Empty installations replace fake metrics with a setup path: configure provider,
create blueprint, then test in Playground.

## Agents

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ Agents                                  Filter ▾   Search…      New agent   │
├─────────────────────────────────────────────────────────────────────────────┤
│ 4 total · 2 active · 1 idle · 1 degraded                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│ ● Atlas        General assistant     Qwen 3 / Local       2 conversations  │
│   default@3    Discord, Web           Active now           1 activity       │
├─────────────────────────────────────────────────────────────────────────────┤
│ ● Ada          Critical reviewer      GPT / Cloud          No conversations │
│   critic@7     Deliberation only      Idle                 2 activities     │
├─────────────────────────────────────────────────────────────────────────────┤
│ ! Scout        Research agent         Llama / Local        Last run failed  │
│   research@2   Web                    Degraded             Inspect →         │
└─────────────────────────────────────────────────────────────────────────────┘
```

Agent detail:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ ← Agents    Atlas  ● Healthy              Pause   Test in Playground   •••  │
│ General assistant · default blueprint @ v3                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ Overview   Sessions   Research   Deliberation   Runs   Configuration         │
├───────────────────────────────┬─────────────────────────────────────────────┤
│ Current activity              │ Runtime                                     │
│ Discord response · 00:12      │ Provider/model   Local / Qwen 3             │
│ [Inspect run]                 │ Context          42% · 12.4k / 30k          │
│                               │ Last heartbeat   now                         │
│ Connections                   │                                             │
│ Discord ●   Web ●             │ Efficiency                                  │
│                               │ Cache reuse      71%                         │
│ Recent runs                   │ Context avoided  18.2k today                │
│ ✓ 1.8 s  Discord             │                                             │
│ ✓ 3.2 s  Web                 │                                             │
└───────────────────────────────┴─────────────────────────────────────────────┘
```

## Blueprints

Blueprints use a library layout because they are authored objects, not live
processes.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ Blueprints                              Search…     Import     New blueprint│
├─────────────────────────────────────────────────────────────────────────────┤
│ NAME             PROVIDER / MODEL      TOOLS       USED BY      UPDATED     │
│ default          llama / gemma4        2 lazy      1 agent      2 h ago     │
│ critic           cloud / gpt           3 core      1 agent      yesterday   │
│ researcher       local / qwen          6 total     2 agents     4 d ago     │
└─────────────────────────────────────────────────────────────────────────────┘
```

Blueprint editor:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ ← Blueprints   Edit “researcher”             Duplicate   Save changes      │
├──────────────────────┬────────────────────────────────────┬─────────────────┤
│ Sections             │ Configuration                      │ Validation      │
│                      │                                    │                 │
│ General              │ Name          researcher           │ ✓ Provider      │
│ Instructions         │ Description   Research and verify… │ ✓ Model         │
│ Provider & model     │                                    │ ✓ Tools         │
│ Tools                │ System instructions                │                 │
│ Context & memory     │ ┌────────────────────────────────┐ │ Used by         │
│ Limits               │ │ You investigate claims…       │ │ Scout           │
│ Permissions          │ │                                │ │ Research team   │
│ Versions             │ └────────────────────────────────┘ │                 │
│                      │                                    │ Unsaved changes │
└──────────────────────┴────────────────────────────────────┴─────────────────┘
```

The right inspector prevents saving broken provider/model/tool references and
shows the impact of editing a blueprint already in use.

## Deep Research and Deliberation

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ Deep Research                                      Search…   New research  │
├─────────────────────────────────────────────────────────────────────────────┤
│ ACTIVE                                                                      │
│ ◉ Local RAG options                     4/7 tasks     3 agents      61%    │
│                                                                             │
│ RECENT                                                                      │
│ ✓ Bun SQLite comparison                 report ready  2 agents      1 d    │
└─────────────────────────────────────────────────────────────────────────────┘
```

Deliberation has its own equivalent library focused on questions, rounds, and
decision status.

Deep Research retains the proposed four-stage creation flow:

```text
Outcome → Participants & roles → Domain policy & budget → Review
```

Deliberation currently configures its decision, participant blueprints,
moderator, and one-to-five rounds in a single ready-room form. Instructions are
activity-only and clearly separated from blueprint configuration.

### Deep Research

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ Research / Local RAG options   Running · 61%     Pause   Redirect   Stop   │
├───────────────┬─────────────────────────────────────────┬───────────────────┤
│ Overview      │ Activity                                │ Evidence          │
│ Plan          │                                         │ 18 sources        │
│ Tasks     4/7 │ Scout · searching benchmarks           │ 12 supported      │
│ Sources    18 │ ├─ Source found                         │  3 conflicting    │
│ Artifacts   3 │ └─ Extracting relevant claims          │  3 pending        │
│ Runs          │                                         │                   │
│               │ Ada · validating claim #8              │ Budget            │
│               │ └─ Conflict detected                   │ Context       61% │
│               │                                         │ Cloud       $0.08 │
│               │ Coordinator · waiting for 2 tasks      │ Time         08:14 │
└───────────────┴─────────────────────────────────────────┴───────────────────┘
```

### Deliberation

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ Deliberation / Memory architecture       Round 2 of 3              Cancel │
├───────────────┬─────────────────────────────────────┬───────────────────────┤
│ Record        │ Interventions                       │ Protocol              │
│ Proposals     │ Turing · Proposal                   │ Moderator: Maya       │
│ Critiques     │ Use a central append-only log…      │ Participants: 3       │
│ Synthesis     │                                     │ Rounds: 3             │
│               │ Ada · Critique                      │                       │
│ Sessions      │ This creates a single bottleneck…   │ Progress              │
│ Linked per    │                                     │ Round 2 of 3          │
│ intervention  │ Maya · Final synthesis              │                       │
│               │ Recommendation, dissent, risks…     │                       │
└───────────────┴─────────────────────────────────────┴───────────────────────┘
```

Agent identity color is an aid, never the only identifier. Every contribution
also displays name and contextual role.

## Observability: sessions

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ Sessions   Blueprint ▾  Status ▾  Date ▾                    Search…          │
├─────────────────────────────────────────────────────────────────────────────┤
│ STATUS  SESSION              BLUEPRINT  LAST MODEL   RUNS  TOKENS     TIME  │
│ ●       01K…                 default    Qwen local      3   12.4k      now  │
│ ✓       01J…                 research   Qwen local      8   28.1k      2 m  │
│ !       01H…                 default    Qwen local      2   14.7k      8 m  │
└─────────────────────────────────────────────────────────────────────────────┘
```

Session detail with nested runs:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ Session 01K…  ● Active       default · Qwen local       Open Playground   │
├───────────────────────┬───────────────────────────────────┬─────────────────┤
│ Runs                  │ Timeline                          │ Session totals  │
│                       │                                   │                 │
│ ◉ Atlas               │ 00:00 Message received            │ Instructions 2k │
│ ├─ ✓ memory search    │ 00:01 Memory retrieval · 8 hits  │ Task        320 │
│ ├─ ✓ model turn       │ 00:02 Model response · 820 tok   │ Shared      610 │
│ ├─ ◉ Scout subagent   │ 00:03 Spawned Scout              │ Retrieved   940 │
│ │  └─ ◉ web search    │ 00:04 Tool permission requested  │ Transcript  410 │
│ └─ ○ final response   │                                   │ ─────────────── │
│                       │                                   │ Sent       4.3k │
│                       │                                   │ Avoided   11.8k │
└───────────────────────┴───────────────────────────────────┴─────────────────┘
```

## Playground

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ Playground   Agent: Atlas ▾   Session: Scratch ▾    Compare   Clear        │
├──────────────────┬─────────────────────────────────────┬────────────────────┤
│ Session          │ Conversation                        │ Inspector          │
│                  │                                     │                    │
│ Web broker       │ You                                 │ Run                │
│ Atlas            │ Compare these two approaches…       │ ● responding 00:08 │
│ default@3        │                                     │                    │
│ Qwen / Local     │ Atlas                               │ Context      42%   │
│                  │ I would separate…                   │ Sent         4.3k  │
│ Controls         │                                     │ Avoided     11.8k  │
│ Temporary session│ ┌─────────────────────────────────┐ │ Tools        2/4   │
│ Context policy   │ │ Message Atlas…                  │ │ Cost        $0.00 │
│ Tool permissions │ └─────────────────────────────────┘ │                    │
│                  │                         Send  ⌘↵    │ [Inspect run]      │
└──────────────────┴─────────────────────────────────────┴────────────────────┘
```

The inspector follows the selected message/run. It can be collapsed. Compare
mode splits the conversation result and keeps the input fixed while selecting
different blueprints, agents, providers, or models.

## Responsive behavior

- **≥ 1280 px:** persistent sidebar; optional inspector; dense workbench tables.
- **960–1279 px:** compact sidebar; inspector opens as an overlay drawer.
- **< 960 px:** single content column and bottom/overlay navigation. Tables turn
  into prioritized rows, not horizontally compressed grids.
- Active run controls, permission decisions, conversations, and basic status
  remain usable on narrow screens.
- Blueprint authoring, run-tree analysis, and multi-panel research are supported
  but explicitly optimized for desktop.

## Required states for every data surface

Each implemented screen must design and test:

- First-run/empty state with one primary next action.
- Loading state that preserves layout.
- Partial data and unavailable future features.
- Recoverable error with retry.
- Daemon disconnected/reconnecting.
- Permission required.
- Stale data and last-updated time.
