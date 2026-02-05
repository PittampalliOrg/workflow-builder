# Multi-stage Dockerfile for fn-openai OpenFunction
# A scale-to-zero function for OpenAI text and image generation

# Stage 1: Dependencies
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY services/fn-openai/package.json ./

# Install dependencies
RUN pnpm install

# Stage 2: Builder
FROM node:22-alpine AS builder
WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy deps from previous stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source code
COPY services/fn-openai/ ./

# Set build-time environment variables
ENV NODE_ENV=production

# Build the function using esbuild
RUN pnpm build

# Stage 3: Runner (minimal image)
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST="0.0.0.0"

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 function

# Copy only the bundled output
COPY --from=builder --chown=function:nodejs /app/dist ./dist

USER function

EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["node", "dist/index.js"]
