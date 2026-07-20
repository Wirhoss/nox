FROM oven/bun:1-alpine AS ui-builder

WORKDIR /ui

COPY ui/package.json ui/bun.lock ./

RUN bun install --frozen-lockfile

COPY ui/ ./

RUN bun run build

FROM oven/bun:1-alpine AS builder

WORKDIR /app

COPY bun.lock package.json ./

RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/
COPY index.ts ./

RUN bun run build

FROM oven/bun:1-alpine AS runner

WORKDIR /app

RUN addgroup --system app && adduser --system --ingroup app app \
  && mkdir -p /var/lib/nox /etc/nox/config \
  && chown -R app:app /var/lib/nox /etc/nox/config

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=ui-builder --chown=app:app /ui/dist /usr/share/nox/ui

ENV NODE_ENV=production \
    HOST=0.0.0.0

EXPOSE 3000

USER app

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e 'fetch("http://localhost:3000/api/health/live").then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'

ENTRYPOINT ["bun", "run", "dist/index.js"]
