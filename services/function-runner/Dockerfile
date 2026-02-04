# Multi-stage Dockerfile for Function Runner Service
# This service executes functions for Dapr workflows, supporting
# builtin (TypeScript), OCI (container), and HTTP (webhook) execution types.

# Stage 1: Dependencies
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy root package files
COPY package.json pnpm-lock.yaml ./

# Copy service package.json
COPY services/function-runner/package.json ./services/function-runner/

# Install root dependencies (for plugins)
RUN pnpm install --frozen-lockfile

# Install service dependencies
WORKDIR /app/services/function-runner
RUN pnpm install

# Stage 2: Builder
FROM node:22-alpine AS builder
WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy deps from previous stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/services/function-runner/node_modules ./services/function-runner/node_modules

# Copy source code (entire repo needed for path aliases and plugins)
COPY . .

# Set build-time environment variables
ENV NODE_ENV=production

# Run plugin discovery (generates plugins/index.ts)
RUN pnpm discover-plugins

# Build the service using esbuild (bundles everything including plugins)
WORKDIR /app/services/function-runner
RUN pnpm build

# Stage 3: Runner (minimal image)
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST="0.0.0.0"

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 runner

# Copy only the bundled output (esbuild creates a self-contained bundle)
COPY --from=builder --chown=runner:nodejs /app/services/function-runner/dist ./dist

USER runner

EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["node", "dist/index.js"]
