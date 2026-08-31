# Nox UI

The Nox Web UI is a Vue workspace inside the main source tree. It communicates with the runtime through typed HTTP DTOs and SSE events. The current import boundary excludes direct kernel imports and is checked by `src/boundaries.test.ts`.

This file covers working *in* the workspace. The architecture — state ownership, the HTTP contract, theming — is in [docs/ui.md](../../docs/ui.md).

## Structure

```text
app/       Application bootstrap, root component, router, and app-wide stores
routes/    Route-level components
features/  Domain-owned components, stores, and composables
shared/    API client, reusable UI, i18n, and global styles
public/    Static assets copied as-is
```

As a working convention, feature and shared directories are added when a concrete owner needs them.

## Commands

From the repository root:

```sh
bun install
bun run dev:ui
bun run build:ui
bun run test:ui
bun run check:ui
```

Or run the corresponding scripts directly from `src/ui`.

During development, Vite proxies the `/api` namespace to `http://localhost:8080`. Point it at another Nox HTTP surface when needed:

```sh
NOX_API_TARGET=http://localhost:9090 bun run dev:ui
```

The access token exists only in the Pinia auth store. The rotating refresh token remains in the backend-issued HttpOnly cookie and is never exposed to UI code.
