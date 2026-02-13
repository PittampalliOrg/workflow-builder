# Multi-stage Dockerfile for mastra-agent-tanstack

# Stage 1: Dependencies
FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# Stage 2: Builder
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json ./
RUN npm install

COPY . ./

ENV NODE_ENV=production

# Build UI single-file HTML then TanStack Start app
RUN npm run build

# Stage 3: Runner
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3400
ENV HOST="0.0.0.0"

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 mcpserver

COPY --from=builder --chown=mcpserver:nodejs /app/.output ./.output
COPY --from=builder --chown=mcpserver:nodejs /app/dist-ui ./dist-ui
COPY --from=deps --chown=mcpserver:nodejs /app/node_modules ./node_modules

USER mcpserver

EXPOSE 3400

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3400/api/health || exit 1

CMD ["node", ".output/server/index.mjs"]
