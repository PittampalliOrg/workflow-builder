# Multi-stage Dockerfile for mastra-agent-mcp

# Stage 1: Dependencies
FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json ./
RUN npm install -g pnpm && pnpm install --prod

# Stage 2: Builder
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json ./
RUN npm install -g pnpm && pnpm install

COPY . ./

ENV NODE_ENV=production

# Build UI bundles (Vite single-file HTML) then server (esbuild)
RUN pnpm run build:all

# Stage 3: Runner
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3300
ENV HOST="0.0.0.0"

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 mcpserver

COPY --from=builder --chown=mcpserver:nodejs /app/dist ./dist
COPY --from=deps --chown=mcpserver:nodejs /app/node_modules ./node_modules

USER mcpserver

EXPOSE 3300

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3300/health || exit 1

CMD ["node", "dist/index.js"]
