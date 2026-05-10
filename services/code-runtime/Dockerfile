FROM node:22-bookworm AS deps

WORKDIR /app

RUN npm install -g pnpm@9

COPY services/code-runtime/package.json ./
RUN pnpm install --prod=false

FROM node:22-bookworm AS builder

WORKDIR /app

RUN npm install -g pnpm@9

COPY --from=deps /app/node_modules ./node_modules
COPY services/code-runtime/ ./

ENV NODE_ENV=production

RUN pnpm build

FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    python3 \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 1001 coderuntime && \
    useradd --uid 1001 --gid coderuntime --shell /bin/bash --create-home coderuntime

COPY --from=builder --chown=coderuntime:coderuntime /app/dist ./dist
COPY --from=deps --chown=coderuntime:coderuntime /app/node_modules ./node_modules

USER coderuntime

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

CMD ["node", "dist/index.cjs"]
