# Visual system direction

Working name: **Nox Workbench / Mineral Dark**

The interface should feel like a precise local instrument: dark, calm, compact,
and technical without imitating a terminal or using generic neon AI imagery.
The system starts dark-first but all semantic tokens must permit a later light
theme.

## Color foundation

Initial dark-theme tokens:

| Token | Value | Use |
| --- | --- | --- |
| `canvas` | `#0C0F0D` | App background |
| `surface-1` | `#121613` | Sidebar and primary panels |
| `surface-2` | `#181D1A` | Raised controls and selected regions |
| `surface-3` | `#202621` | Hover and active surfaces |
| `border-subtle` | `#252C27` | Section boundaries |
| `border-strong` | `#354038` | Focused and interactive boundaries |
| `text-primary` | `#E7ECE8` | Primary content |
| `text-secondary` | `#A7B0AA` | Supporting content |
| `text-muted` | `#737D77` | Metadata and disabled content |
| `accent` | `#D0A45C` | Primary actions and active navigation |
| `accent-soft` | `#302719` | Accent background |
| `healthy` | `#69B486` | Local/healthy/success |
| `cloud` | `#76A2CE` | Cloud execution and remote resources |
| `warning` | `#D2A85D` | Waiting, budget, attention |
| `danger` | `#D87872` | Failures and destructive actions |
| `research` | `#8E9FD1` | Deep Research identity |
| `deliberation` | `#B18AC8` | Deliberation identity |

Semantic colors never communicate meaning alone. Status always includes an icon,
shape, or label. Provider badges explicitly say `Local` or `Cloud`; color merely
helps scanning.

Before implementation, token pairs must be checked against WCAG contrast in the
actual font sizes. Muted text is not suitable for essential information.

## Typography

- **Interface:** self-hosted Inter Variable or an equivalent neutral variable
  sans. Use the system sans stack until the font asset is intentionally added.
- **Technical data:** self-hosted JetBrains Mono for IDs, model names, token
  counts, durations, logs, and code—not for ordinary paragraphs.
- Default body size: `14px` at `1.45` line height.
- Compact metadata: `12px` at `1.35`.
- Page title: `24px`, medium weight.
- Section title: `15–16px`, semibold.

Sentence case is used throughout. Uppercase is reserved for short sidebar group
labels and compact machine states such as `LOCAL` or `CLOUD`.

## Density and spacing

The base spacing unit is `4px` with this working scale:

```text
1: 4px   2: 8px   3: 12px   4: 16px
5: 20px  6: 24px  8: 32px  10: 40px
```

- Standard control height: `34px`.
- Compact control height: `28px`.
- Comfortable row height: `52px`.
- Dense table row height: `40px`.
- Page gutters: `24px`, increasing to `32px` on wide content.
- Maximum reading width for prose: approximately `760px`.

The eventual preference `Comfortable / Compact` should alter row and control
density without changing information hierarchy.

## Shape and depth

- Controls: `6px` corner radius.
- Panels and dialogs: `8px` corner radius.
- Pills/status badges: fully rounded only when their compact shape is useful.
- Most grouping uses spacing and one-pixel borders.
- Shadows are reserved for overlays, menus, and dialogs; persistent cards do not
  float above the canvas.

## Icons

Use one outline icon family with approximately `1.5px` strokes. Icons are
typically `16px`; navigation icons may be `18px`. Avoid filled decorative icons,
emoji as interface symbols, and unrelated illustrations in operational states.

Agent avatars should begin as deterministic monograms or simple geometric marks.
They must remain recognizable at 20–24px and should not imply that every agent
has a human persona.

## Core components

### Status indicator

Combines shape, text, and optional live motion:

```text
● Healthy   ◉ Running   ○ Idle   ! Degraded   × Failed
```

Only genuinely live activity animates, and animation respects reduced-motion
preferences.

### Origin badge

Compact label for execution location and source:

```text
[LOCAL] [CLOUD] [DISCORD] [WHATSAPP] [WEB] [API]
```

Origin badges use quiet surfaces. They are not primary buttons.

### Resource meter

Displays value, limit, and interpretation together. It cannot be only a progress
bar:

```text
Context   12.4k / 30k   42%
```

Threshold color begins only when the value requires attention.

### Activity row

One-line default with expandable evidence:

```text
14:32  Discord → Atlas → Qwen local                  1.8 s
```

Expanded rows reveal run ID, context, tools, broker metadata, and errors without
forcing navigation.

### Inspector

A contextual right panel, normally `300–360px` wide. It follows the selected
agent, message, task, source, or run. Closing it increases working space and does
not clear selection.

### Command palette

Global search and navigation activated with `⌘K`/`Ctrl+K`. Results are grouped
by actions and domain objects. Mutating actions clearly disclose their effect.

### Data table

Tables prioritize scanning and sorting over decoration. The first column remains
identifiable when other columns collapse. Filters are represented as removable
criteria and can be shared through the URL.

### Empty state

Uses a concise explanation, one primary action, and at most one secondary link.
It should never display invented activity or decorative analytics.

## Motion

- Fast interaction feedback: `100–140ms`.
- Panel and overlay transitions: `160–220ms`.
- No ambient animation.
- Streaming and running states use subtle opacity or position changes rather than
  glowing effects.
- Run-tree additions should preserve spatial position to avoid losing the user's
  inspection context.

## Voice and labels

Nox uses direct operational language:

- “Start research”, not “Unleash agents”.
- “Waiting for permission”, not “Thinking…”.
- “Provider unavailable”, not “Something went wrong”.
- “Context avoided”, accompanied by the method used to estimate it.

Labels describe real system state and avoid anthropomorphizing infrastructure.
Agent-authored conversational content may retain each configured personality.

## Accessibility baseline

- Keyboard access for all primary flows and visible focus rings.
- No meaning conveyed by color alone.
- Reduced-motion support from the first component.
- Minimum interactive target of approximately `32px` in dense desktop views and
  `44px` on touch-oriented layouts.
- Logs, timelines, streaming messages, and status changes must not produce
  disruptive screen-reader announcements.
- The three-column layout follows a logical DOM reading order: navigation,
  primary content, inspector.
