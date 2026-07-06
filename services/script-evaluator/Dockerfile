# Multi-stage Dockerfile for script-evaluator

# Stage 1: Dependencies
FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json ./
# pnpm pinned to v9: unpinned installs pull pnpm v10, which hard-fails prod
# installs on un-allowlisted dependency build scripts (ERR_PNPM_IGNORED_BUILDS).
RUN npm install -g pnpm@9 && pnpm install --prod

# Stage 2: Builder
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json ./
RUN npm install -g pnpm@9 && pnpm install --prod=false

COPY . ./

ENV NODE_ENV=production

# Bundle the server (esbuild)
RUN pnpm run build

# Stage 3: Runner
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3300
ENV HOST="0.0.0.0"

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 evaluator

COPY --from=builder --chown=evaluator:nodejs /app/dist ./dist
COPY --from=deps --chown=evaluator:nodejs /app/node_modules ./node_modules

USER evaluator

EXPOSE 3300

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3300/healthz || exit 1

# --experimental-vm-modules is REQUIRED: the sandbox uses vm.SourceTextModule.
CMD ["node", "--experimental-vm-modules", "dist/index.js"]
