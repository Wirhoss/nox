# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# Nox — multi-stage image.
# ---------------------------------------------------------------------------

ARG BUN_VERSION=1.3.14
ARG BUN_IMAGE=oven/bun:${BUN_VERSION}-alpine


# --- deps ------------------------------------------------------------------
FROM ${BUN_IMAGE} AS deps

WORKDIR /build

COPY package.json bun.lock ./
# Bun validates every declared workspace before installing. The UI build also
# needs the workspace's development dependencies (Vite, Vue and Sass).
COPY src/ui/package.json ./src/ui/package.json
RUN bun install --frozen-lockfile --ignore-scripts

# --- build -----------------------------------------------------------------
FROM ${BUN_IMAGE} AS build

WORKDIR /build

COPY --from=deps /build/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json index.ts ./
COPY src ./src
COPY --from=deps /build/src/ui/node_modules ./src/ui/node_modules

RUN bun build ./index.ts \
      --target=bun \
      --outfile ./dist/nox.js \
      --minify-whitespace \
      --minify-syntax \
 && bun --cwd=src/ui run build-only \
 && cp -R ./src/database/migrations ./dist/migrations

# --- runtime ---------------------------------------------------------------
FROM ${BUN_IMAGE} AS runtime

ARG BUN_IMAGE
ARG NOX_VERSION=0.1.0

LABEL org.opencontainers.image.title="nox" \
      org.opencontainers.image.description="Nox agent runtime" \
      org.opencontainers.image.version="${NOX_VERSION}" \
      org.opencontainers.image.licenses="UNLICENSED" \
      org.opencontainers.image.base.name="${BUN_IMAGE}"

RUN addgroup -g 10001 nox \
 && adduser -D -H -u 10001 -G nox -s /sbin/nologin nox \
 && install -d -m 0750 -o nox -g nox /home/nox /etc/nox/config /var/lib/nox \
 && install -d -m 0555 -o root -g root /app \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} +

COPY --from=build --chown=root:root /build/dist/nox.js /app/nox.js
COPY --from=build --chown=root:root /build/dist/migrations /app/migrations
COPY --from=build --chown=root:root /build/src/ui/dist /app/ui

# --- environment -----------------------------------------------------------
# Every variable Nox reads, named here rather than left to a default.
ENV NODE_ENV=production \
    CONFIG_DIR=/etc/nox/config \
    DATA_DIR=/var/lib/nox \
    UI_DIR=/app/ui \
    HOME=/home/nox \
    TZ=UTC

USER 10001:10001
WORKDIR /app

# The HTTP surface: the health probes an orchestrator asks before it routes.
EXPOSE 8080

STOPSIGNAL SIGINT

# Liveness only. Readiness (/api/health/ready) decides whether traffic should
# arrive, which is the orchestrator's call, not the container runtime's — a
# dependency that is down must not restart a process that is still answering.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3   CMD wget -q -O /dev/null http://127.0.0.1:8080/api/health/live || exit 1

ENTRYPOINT ["bun", "run", "/app/nox.js"]
