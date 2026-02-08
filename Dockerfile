# Multi-stage Dockerfile for Workflow Builder (Next.js 16 Standalone)

# Stage 1: Dependencies
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Stage 2: Builder
FROM node:22-alpine AS builder
WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy deps from previous stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source code
COPY . .

# Set build-time environment variables
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# Build-time environment variables
ARG NEXT_PUBLIC_APP_URL="https://workflow-builder.cnoe.localtest.me:8443"
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}

# Bundle scripts for runtime use (self-contained with dependencies)
RUN npm install -g esbuild && \
    esbuild lib/db/migrate.ts --bundle --platform=node --target=node22 --outfile=lib/db/migrate.bundle.js && \
    esbuild scripts/seed-functions.ts --bundle --platform=node --target=node22 --outfile=scripts/seed-functions.bundle.js && \
    esbuild scripts/sync-activepieces-pieces.ts --bundle --platform=node --target=node22 --outfile=scripts/sync-activepieces-pieces.bundle.js

# Run plugin discovery and build
RUN pnpm discover-plugins && pnpm next build

# Stage 3: Runner
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone build output
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Copy database migration files and bundled scripts
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/lib/db/migrate.bundle.js ./lib/db/migrate.bundle.js
COPY --from=builder /app/scripts/seed-functions.bundle.js ./scripts/seed-functions.bundle.js
COPY --from=builder /app/scripts/sync-activepieces-pieces.bundle.js ./scripts/sync-activepieces-pieces.bundle.js

USER nextjs

EXPOSE 3000

# Run migrations then start the server
CMD ["sh", "-c", "node lib/db/migrate.bundle.js && node server.js"]
