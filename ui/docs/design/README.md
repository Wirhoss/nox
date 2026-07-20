# Nox Workbench design foundation

Status: first review draft

Nox is a local-first workbench for configuring, operating, and inspecting one or
many AI agents. Chat is available in the web application, but it is one broker
and one debugging surface among several—not the product's organizing metaphor.

This directory records the product and interface decisions that should be
reviewed before implementation:

- [Information architecture](./information-architecture.md): product model,
  navigation, routes, and primary workflows.
- [Wireframes](./wireframes.md): low-fidelity layouts for the first screens.
- [Visual system](./visual-system.md): initial visual direction and interface
  tokens.

## Product statement

> Build, connect, observe, and improve local-first agents from one workbench.

## Design principles

### Workbench before chat

The default view explains what the system is doing. It prioritizes agent health,
active work, broker traffic, permissions, errors, resource use, and recent
activity. The web chat lives in Playground and remains fully capable.

### Local is a visible property

Local and cloud execution must never be implicit. Providers, models, runs, and
cost surfaces identify where work happens. Cloud usage and estimated cost are
visible before and after execution.

### Inspect without drowning

Every high-level status can be expanded into evidence: a conversation into its
runs, a run into its steps, and a Deep Research or Deliberation activity into its task tree.
Technical detail is progressively disclosed rather than permanently occupying
the interface.

### Multi-agent by default

Layouts and language assume multiple simultaneous agents, even while the
backend initially exposes only blueprint-based sessions. Deep Research,
deliberation, and future subagents use the same underlying execution model.

### Context is a managed resource

Context size, compaction, cache reuse, retrieval, and avoided context are
first-class metrics. Nox should make efficient orchestration understandable,
not merely claim that it is efficient.

### Intervention stays close to activity

Pause, abort, approve, retry, redirect, or inspect actions appear where the
related activity is shown. Dangerous actions are explicit and reversible where
possible.

## First implementation boundary

The first UI milestone should establish the application shell and the screens
supported by the current API:

1. Overview with real health and summary data where available.
2. Blueprint list, create, edit, and delete.
3. Session list and session inspection.
4. Playground chat with streaming activity and permission handling.
5. Provider configuration plus installed tool inspection and permission policy.

Agents as persistent runtime instances, broker-specific settings, Deep Research,
Deliberation, run graphs, and detailed usage metrics remain visible
in the information architecture but should use honest empty or unavailable
states until their backend contracts exist. Broker and tool implementations are
supplied by Nox or app extensions; the workbench configures installed
capabilities and never authors new implementations.

## API terminology

Blueprint configuration is exposed under `/api/v1/blueprints`. The `/agents`
namespace remains reserved for future configured or running instances. This
keeps the product distinction explicit from the first implemented UI screens.
