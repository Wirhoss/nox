# Nox Workbench UI

Astro 7 and Svelte 5 interface for the local Nox daemon.

The product model, wireframes, and initial visual system live in
[`docs/design`](./docs/design/README.md).

During local UI development, requests under `/api` are proxied to the Nox daemon
at `http://localhost:3000`.

## Commands

Run these commands from `ui/`:

| Command | Action |
| :--- | :--- |
| `bun install` | Install dependencies |
| `bun dev` | Start the UI at `localhost:4321` |
| `bun build` | Build the static application into `dist/` |
| `bun preview` | Preview the production build |
| `bun astro ...` | Run Astro CLI commands |

For the complete local application, start the Nox daemon from the repository
root before starting the UI development server.
