# Multi-stage Dockerfile for MCP Gateway Service
#
# Exposes a Streamable HTTP MCP endpoint and proxies tool execution into the
# workflow-builder Next.js app via internal endpoints.

# Stage 1: Dependencies
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

RUN npm install -g pnpm

COPY services/mcp-gateway/package.json ./
RUN pnpm install

# Stage 2: Builder
FROM node:22-alpine AS builder
WORKDIR /app

RUN npm install -g pnpm

COPY --from=deps /app/node_modules ./node_modules
COPY services/mcp-gateway/ ./

ENV NODE_ENV=production
RUN pnpm build

# Stage 3: Runner
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST="0.0.0.0"

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 mcp

COPY --from=builder --chown=mcp:nodejs /app/dist ./dist

USER mcp

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["node", "dist/index.js"]

