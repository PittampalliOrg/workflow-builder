# Multi-stage Dockerfile for fn-activepieces
# Generic executor for 25 Activepieces piece packages

# Stage 1: Dependencies
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY services/fn-activepieces/package.json ./

# Install dependencies (production only to keep image smaller)
RUN pnpm install --prod

# Stage 2: Builder
FROM node:22-alpine AS builder
WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy all deps (including dev for build)
COPY services/fn-activepieces/package.json ./
RUN pnpm install

# Copy source code
COPY services/fn-activepieces/ ./

# Set build-time environment variables
ENV NODE_ENV=production

# Build the function using esbuild (bundles our code, externals all packages)
RUN pnpm build

# Stage 3: Runner
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST="0.0.0.0"

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 function

# Copy bundled output
COPY --from=builder --chown=function:nodejs /app/dist ./dist

# Copy production node_modules (AP pieces need their deps at runtime)
COPY --from=deps --chown=function:nodejs /app/node_modules ./node_modules

USER function

EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["node", "dist/index.js"]
