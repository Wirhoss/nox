# Nox UI

The Nox Web UI is an isolated Vue workspace inside the main source tree. It communicates with the runtime through typed HTTP DTOs and SSE events; it must not import kernel classes directly.

## Structure

```text
app/       Application bootstrap, root component, and router
routes/    Route-level components
features/  Domain-owned components, stores, and composables
shared/    API client, reusable UI, libraries, and global styles
assets/    Source assets
public/    Static assets copied as-is
```

Feature and shared directories are added only when their first real owner exists.

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
