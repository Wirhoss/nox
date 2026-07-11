FROM oven/bun:1-alpine AS builder

WORKDIR /app

COPY bun.lock package.json ./

RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/
COPY config/ ./config/
COPY index.ts ./

RUN bun run build

FROM oven/bun:1-alpine AS runner

WORKDIR /app

RUN addgroup --system app && adduser --system --ingroup app app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/config ./config

USER app

# Health check THIS IS A TODO: implement a health check endpoint in the app and use it here

ENTRYPOINT ["bun", "run", "dist/index.js"]
