# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# Nox — multi-stage image.
# ---------------------------------------------------------------------------

ARG BUN_VERSION=1.3.14
# Transformers.js loads onnxruntime-node, whose Linux binaries target glibc.
# Keep every stage on the same Debian base so native dependencies are installed
# for the libc used by the final image.
ARG BUN_IMAGE=oven/bun:${BUN_VERSION}-slim


# --- deps ------------------------------------------------------------------
FROM ${BUN_IMAGE} AS deps

WORKDIR /build

COPY package.json bun.lock ./
# Bun validates every declared workspace before installing. The UI build also
# needs the workspace's development dependencies (Vite, Vue and Sass).
COPY packages/extension-api/package.json ./packages/extension-api/package.json
COPY src/ui/package.json ./src/ui/package.json
RUN bun install --frozen-lockfile --ignore-scripts

# --- runtime deps ----------------------------------------------------------
# Sharp is a native Node-API module and cannot live inside the Bun bundle. Keep
# only production dependencies for the root workspace, installed for the target
# image platform so its matching libvips binary is present at runtime.
FROM ${BUN_IMAGE} AS runtime-deps

ARG TARGETARCH

WORKDIR /build

COPY package.json bun.lock ./
COPY packages/extension-api/package.json ./packages/extension-api/package.json
COPY src/ui/package.json ./src/ui/package.json
RUN bun install --frozen-lockfile --ignore-scripts --linker=hoisted --omit peer --production --filter nox

# The upstream ONNX package contains native binaries for every supported OS and
# architecture in one tarball. The Node build of Transformers bundles its web
# backend, so the separate onnxruntime-web package is also redundant here.
# Retain only the native binary that can execute in this image, and discard musl
# Sharp variants now that the runtime is intentionally glibc-based.
RUN set -eux; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) onnx_arch=x64 ;; \
      arm64) onnx_arch=arm64 ;; \
      *) echo "Unsupported ONNX Runtime architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    find node_modules/onnxruntime-node/bin/napi-v6 \
      -mindepth 1 -maxdepth 1 -type d ! -name linux -exec rm -rf '{}' +; \
    find node_modules/onnxruntime-node/bin/napi-v6/linux \
      -mindepth 1 -maxdepth 1 -type d ! -name "${onnx_arch}" -exec rm -rf '{}' +; \
    rm -rf node_modules/onnxruntime-web; \
    find node_modules -type d \
      \( -name 'sharp-linuxmusl-*' -o -name 'sharp-libvips-linuxmusl-*' \) \
      -prune -exec rm -rf '{}' +

# --- build -----------------------------------------------------------------
FROM ${BUN_IMAGE} AS build

WORKDIR /build

COPY --from=deps /build/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json index.ts ./
COPY packages ./packages
COPY --from=deps /build/packages/extension-api/node_modules ./packages/extension-api/node_modules
COPY scripts ./scripts
COPY src ./src
COPY --from=deps /build/src/ui/node_modules ./src/ui/node_modules

RUN bun run build:extensions \
 && bun build ./index.ts \
      --target=bun \
      --outfile ./dist/nox.js \
      --external @huggingface/transformers \
      --external playwright \
      --external sharp \
      --external zod \
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

# Playwright is a lazy client, but a configured local instance needs a browser
# executable. Debian's Chromium uses the same glibc as ONNX Runtime; no
# Playwright browser download is performed, and no browser process starts until
# the first browser tool call.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates chromium wget \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 nox \
 && useradd --uid 10001 --gid nox --no-create-home --home-dir /home/nox --shell /usr/sbin/nologin nox \
 && install -d -m 0750 -o nox -g nox /home/nox /etc/nox/config /var/lib/nox \
 && install -d -m 0555 -o root -g root /app \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} +

COPY --from=build --chown=root:root /build/dist/nox.js /app/nox.js
COPY --from=runtime-deps --chown=root:root /build/node_modules /app/node_modules
RUN rm -rf /app/node_modules/@nox/extension-api
COPY --from=build --chown=root:root /build/dist/node_modules/@nox/extension-api /app/node_modules/@nox/extension-api
COPY --from=build --chown=root:root /build/dist/extensions /app/extensions
COPY --from=build --chown=root:root /build/dist/migrations /app/migrations
COPY --from=build --chown=root:root /build/src/ui/dist /app/ui

# Fail the build if the native ONNX binding ever stops matching the runtime
# image. Importing Transformers eagerly loads that binding but downloads no
# model weights.
RUN cd /app \
 && bun -e 'const runtime = await import("@huggingface/transformers"); if (typeof runtime.pipeline !== "function") throw new Error("Transformers pipeline export is unavailable")'

# --- environment -----------------------------------------------------------
# Every variable Nox reads, named here rather than left to a default.
ENV NODE_ENV=production \
    CONFIG_DIR=/etc/nox/config \
    DATA_DIR=/var/lib/nox \
    EXTENSIONS_DIR=/var/lib/nox/extensions \
    UI_DIR=/app/ui \
    HOME=/home/nox \
    NODE_PATH=/app/node_modules \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
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
