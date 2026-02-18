# Multi-stage Dockerfile for durable-agent service
# Build context: services/durable-agent/

# Stage 1: Production dependencies
FROM node:22-alpine AS deps
WORKDIR /app
ARG PNPM_VERSION=9.12.3

COPY package.json ./
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate && pnpm install --prod

# Stage 2: Builder (all deps + tsc build)
FROM node:22-alpine AS builder
WORKDIR /app
ARG PNPM_VERSION=9.12.3

COPY package.json tsconfig.json ./
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate && pnpm install --prod=false

COPY src/ ./src/

ENV NODE_ENV=production

RUN pnpm run build

# Stage 3: Runner (minimal image)
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8001
ENV HOST="0.0.0.0"

# Install bubblewrap for local sandbox isolation fallback and git for workspace ops
RUN apk add --no-cache bubblewrap git && \
    addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 agent && \
    mkdir -p /app/workspace && chown agent:nodejs /app/workspace

COPY --from=builder --chown=agent:nodejs /app/dist ./dist
COPY --from=deps --chown=agent:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=agent:nodejs /app/package.json ./package.json

USER agent

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8001/api/health || exit 1

CMD ["node", "dist/service/main.js"]
