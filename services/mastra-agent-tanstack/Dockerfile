# Multi-stage Dockerfile for mastra-agent-tanstack

# Stage 1: Builder (all deps + build)
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json ./
RUN npm install --legacy-peer-deps

COPY . ./

ENV NODE_ENV=production

# Build UI single-file HTML then TanStack Start app (Nitro output)
RUN npm run build

# Stage 2: Runner
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3400
ENV HOST="0.0.0.0"

# Install bubblewrap for local sandbox isolation fallback (bwrap).
# When SANDBOX_BACKEND=k8s (default in-cluster), bwrap is unused but harmless.
# When SANDBOX_BACKEND=local, bwrap provides OS-level command isolation.
RUN apk add --no-cache bubblewrap git && \
    addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 mcpserver && \
    mkdir -p /app/workspace && chown mcpserver:nodejs /app/workspace

# Nitro bundles everything into .output (includes node_modules internally)
COPY --from=builder --chown=mcpserver:nodejs /app/.output ./.output
COPY --from=builder --chown=mcpserver:nodejs /app/dist-ui ./dist-ui

USER mcpserver

EXPOSE 3400

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3400/api/health || exit 1

CMD ["node", ".output/server/index.mjs"]
